import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const forbiddenRuntimeImports = [
  "node:",
  "fs",
  "net",
  "tls",
  "child_process",
  "worker_threads"
];

const forbiddenFragments = [
  "require(",
  "eval(",
  "new Function(",
  "process.",
  "Buffer."
];

const sourceFiles = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
    } else if (path.endsWith(".ts")) {
      sourceFiles.push(path);
    }
  }
}

walk("src");

for (const path of sourceFiles) {
  const text = readFileSync(path, "utf8");

  if (/\bany\b/.test(text)) {
    throw new Error(`Explicit any is not allowed in ${path}`);
  }

  for (const fragment of forbiddenFragments) {
    if (text.includes(fragment)) {
      throw new Error(`Forbidden runtime fragment ${fragment} in ${path}`);
    }
  }

  for (const moduleName of forbiddenRuntimeImports) {
    const importPattern = new RegExp(`from\\s+["']${moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (importPattern.test(text)) {
      throw new Error(`Forbidden runtime import ${moduleName} in ${path}`);
    }
  }
}

console.log(`checked ${sourceFiles.length} source files`);
