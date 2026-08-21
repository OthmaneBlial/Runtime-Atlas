import path from "node:path";
import {
  Node,
  Project,
  type CallExpression,
  type ObjectLiteralExpression,
  SyntaxKind,
  ts,
} from "ts-morph";
import type {
  AtlasEdge,
  AtlasNode,
  AtlasTopology,
  NodeKind,
} from "../shared/types.js";

const NODE_KINDS = new Set<NodeKind>([
  "route",
  "middleware",
  "service",
  "database",
  "cache",
  "external",
  "queue",
]);
const MAX_SOURCE_FILES = 5_000;

function readStringProperty(
  object: ObjectLiteralExpression,
  name: string,
): string | undefined {
  const property = object.getProperty(name);
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  const initializer = property.getInitializer();
  if (
    !initializer ||
    (!Node.isStringLiteral(initializer) &&
      !Node.isNoSubstitutionTemplateLiteral(initializer))
  ) {
    return undefined;
  }
  return initializer.getLiteralText();
}

function readMeta(
  object: ObjectLiteralExpression,
): Record<string, string> | undefined {
  const property = object.getProperty("meta");
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  const initializer = property.getInitializer();
  if (!initializer || !Node.isObjectLiteralExpression(initializer))
    return undefined;

  const entries: Array<[string, string]> = [];
  for (const child of initializer.getProperties()) {
    if (!Node.isPropertyAssignment(child)) continue;
    const value = child.getInitializer();
    if (
      !value ||
      (!Node.isStringLiteral(value) &&
        !Node.isNoSubstitutionTemplateLiteral(value))
    )
      continue;
    entries.push([child.getName(), value.getLiteralText()]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function atlasKind(call: CallExpression): NodeKind | undefined {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return undefined;
  if (expression.getExpression().getText() !== "atlas") return undefined;
  const name = expression.getName() as NodeKind;
  return NODE_KINDS.has(name) ? name : undefined;
}

export function analyzeProject(entryPatterns: string[]): AtlasTopology {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: false,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  });
  project.addSourceFilesAtPaths(entryPatterns);
  const sourceFiles = project.getSourceFiles();
  if (!sourceFiles.length)
    throw new Error(`No source files matched: ${entryPatterns.join(", ")}`);
  if (sourceFiles.length > MAX_SOURCE_FILES) {
    throw new Error(
      `Static analysis matched ${sourceFiles.length} files; narrow ATLAS_SOURCE_GLOB below ${MAX_SOURCE_FILES}`,
    );
  }
  const nodes: AtlasNode[] = [];
  const nodesById = new Map<string, AtlasNode>();
  type DeclarationRecord = {
    node: AtlasNode;
    call: CallExpression;
    file: string;
  };
  const declarations: DeclarationRecord[] = [];
  const declarationsByLocalName = new Map<string, DeclarationRecord>();
  const declarationsBySymbol = new Map<string, DeclarationRecord[]>();

  const localKey = (file: string, symbol: string) => `${file}::${symbol}`;

  for (const sourceFile of sourceFiles) {
    // Instrumentation is commonly declared inside a factory so that each app
    // instance can receive its own runtime. Traverse the complete source tree
    // instead of limiting discovery to module-level declarations.
    for (const declaration of sourceFile.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )) {
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      const kind = atlasKind(initializer);
      if (!kind) continue;
      const descriptor = initializer.getArguments()[0];
      if (!descriptor || !Node.isObjectLiteralExpression(descriptor)) continue;

      const symbol = declaration.getName();
      const id = readStringProperty(descriptor, "id");
      const label = readStringProperty(descriptor, "label");
      if (!id || !label) continue;

      const start = declaration.getNameNode().getStartLinePos();
      const location = sourceFile.getLineAndColumnAtPos(start);
      const node: AtlasNode = {
        id,
        symbol,
        label,
        kind,
        description: readStringProperty(descriptor, "description"),
        meta: readMeta(descriptor),
        source: {
          file: path.relative(process.cwd(), sourceFile.getFilePath()),
          line: location.line,
          column: location.column,
        },
      };
      const duplicate = nodesById.get(node.id);
      if (duplicate) {
        throw new Error(
          `Duplicate Runtime Atlas node id "${node.id}" in ${duplicate.source.file}:${duplicate.source.line} and ${node.source.file}:${node.source.line}`,
        );
      }
      nodesById.set(node.id, node);
      nodes.push(node);
      const file = sourceFile.getFilePath();
      const record = { node, call: initializer, file };
      declarations.push(record);
      declarationsByLocalName.set(localKey(file, symbol), record);
      declarationsBySymbol.set(symbol, [
        ...(declarationsBySymbol.get(symbol) ?? []),
        record,
      ]);
    }
  }

  const edgesById = new Map<string, AtlasEdge>();
  for (const { node, call, file } of declarations) {
    const handler = call.getArguments()[1];
    if (!handler) continue;
    const nestedCalls = handler.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const nestedCall of nestedCalls) {
      const expression = nestedCall.getExpression();
      if (!Node.isIdentifier(expression)) continue;
      const calledName = expression.getText();
      let target = declarationsByLocalName.get(
        localKey(file, calledName),
      )?.node;

      if (!target) {
        const sourceFile = call.getSourceFile();
        for (const importDeclaration of sourceFile.getImportDeclarations()) {
          const imported = importDeclaration
            .getNamedImports()
            .find(
              (namedImport) =>
                (namedImport.getAliasNode()?.getText() ??
                  namedImport.getName()) === calledName,
            );
          if (!imported) continue;
          const importedFile = importDeclaration
            .getModuleSpecifierSourceFile()
            ?.getFilePath();
          if (!importedFile) continue;
          target = declarationsByLocalName.get(
            localKey(importedFile, imported.getName()),
          )?.node;
          if (target) break;
        }
      }

      if (!target) {
        const candidates = declarationsBySymbol.get(calledName) ?? [];
        if (candidates.length === 1) target = candidates[0].node;
      }
      if (!target || target.id === node.id) continue;
      const id = `${node.id}->${target.id}`;
      edgesById.set(id, { id, source: node.id, target: target.id });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceRoot:
      entryPatterns.length === 1
        ? path.dirname(
            path.relative(process.cwd(), sourceFiles[0].getFilePath()),
          )
        : ".",
    nodes,
    edges: [...edgesById.values()],
  };
}

export function analyzeApplication(entryFile: string): AtlasTopology {
  return analyzeProject([entryFile]);
}
