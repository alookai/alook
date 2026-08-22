import { readdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

const sourceRoot = resolve("src");
const distRoot = resolve("dist");

function filesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const expected = new Set();
for (const source of filesUnder(sourceRoot)) {
  const rel = relative(sourceRoot, source);
  if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel.endsWith(".spec.ts")) continue;
  const stem = rel.slice(0, -3);
  for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) expected.add(stem + suffix);
}

for (const output of filesUnder(distRoot)) {
  if (!expected.has(relative(distRoot, output))) rmSync(output, { force: true });
}

function removeEmptyDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirectories(resolve(root, entry.name));
  }
  if (root !== distRoot && readdirSync(root).length === 0) rmSync(root, { recursive: true });
}

removeEmptyDirectories(distRoot);
