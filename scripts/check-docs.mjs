import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const skippedDirectories = new Set([
  ".git",
  "dist",
  "dist-server",
  "node_modules",
]);

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) return [];
        return markdownFiles(path.join(directory, entry.name));
      }
      return entry.isFile() && entry.name.endsWith(".md")
        ? [path.join(directory, entry.name)]
        : [];
    }),
  );
  return nested.flat();
}

const missing = [];
const files = await markdownFiles(root);
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(markdownLink)) {
    const destination = match[1];
    if (/^(?:https?:|mailto:|#)/i.test(destination)) continue;
    const pathname = decodeURIComponent(destination.split("#", 1)[0]);
    if (!pathname) continue;
    const target = pathname.startsWith("/")
      ? path.join(root, pathname)
      : path.resolve(path.dirname(file), pathname);
    try {
      await stat(target);
    } catch {
      missing.push(`${path.relative(root, file)} -> ${destination}`);
    }
  }
}

if (missing.length) {
  process.stderr.write(
    `Broken local documentation links:\n${missing.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Documentation links verified across ${files.length} Markdown files.\n`,
);
