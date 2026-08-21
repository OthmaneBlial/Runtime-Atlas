import { execFileSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const required = [
  ".editorconfig",
  ".env.example",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".nvmrc",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "compose.yaml",
  "docs/architecture.md",
  "docs/assets/runtime-atlas-checkout.png",
  "docs/assets/runtime-atlas-inspector.png",
  "docs/assets/runtime-atlas-mobile.png",
  "docs/assets/runtime-atlas-overview.png",
  "docs/deployment.md",
  "docs/privacy.md",
  "docs/release-checklist.md",
  "docs/troubleshooting.md",
  "package-lock.json",
];

const failures = [];
for (const file of required) {
  try {
    await access(path.join(root, file));
  } catch {
    failures.push(`required project file is missing: ${file}`);
  }
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
for (const file of tracked) {
  if (
    file === ".env" ||
    (file.startsWith(".env.") && file !== ".env.example") ||
    file.startsWith("dist/") ||
    file.startsWith("dist-server/") ||
    file.startsWith("node_modules/") ||
    file.endsWith(".tgz") ||
    file.endsWith(".tsbuildinfo") ||
    file.endsWith(".DS_Store")
  ) {
    failures.push(`generated or local-only file is tracked: ${file}`);
  }
}

const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

let scanned = 0;
for (const file of candidates) {
  const absolute = path.join(root, file);
  const metadata = await stat(absolute);
  if (!metadata.isFile() || metadata.size > 2 * 1_024 * 1_024) continue;
  const content = await readFile(absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  scanned += 1;
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    failures.push(`possible credential material found: ${file}`);
  }
}

if (failures.length) {
  process.stderr.write(
    `Repository policy check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Repository policy verified: ${required.length} required files, ${tracked.length} tracked paths, ${scanned} text files scanned.\n`,
);
