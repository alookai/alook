import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function verifyDeprecatedReferences(packageRoot, locations, existing = []) {
  const require = createRequire(join(packageRoot, "package.json"));
  const cli = join(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
  const token = randomUUID();
  const paths = locations.map(({ directory, extension }, index) =>
    join(packageRoot, directory, `eslint-deprecation-${token}-${index}${extension}`),
  );
  const existingPaths = existing.map((path) => join(packageRoot, path));
  const groups = new Map([["", []]]);
  for (const [index, location] of locations.entries()) {
    const group = location.group ?? "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(paths[index]);
  }
  groups.get("").push(...existingPaths);
  const deprecated = `import { parse } from "node:url";
/** @deprecated Use currentApi. */
export const legacyApi = () => "legacy";
export const currentApi = () => "current";
export const localResult = legacyApi();
export const dependencyResult = parse("https://example.test/path");
/** @deprecated Compatibility probe. */
export const caretRangeFromPoint = () => "legacy";
export const compatibilityResult = caretRangeFromPoint();
`;
  const supported = `export const currentApi = () => "current";
export const localResult = currentApi();
export const dependencyResult = new URL("https://example.test/path");
`;
  const lint = (expectedStatus) => {
    const deadline = performance.now() + 60_000;
    let remainingOutput = 4 * 1024 * 1024;
    const rows = [];
    for (const targets of groups.values()) {
      if (targets.length === 0) continue;
      const timeout = Math.floor(deadline - performance.now());
      assert.ok(timeout > 0, "ESLint phase exceeded 60 seconds");
      assert.ok(remainingOutput > 0, "ESLint phase exhausted its 4 MiB output budget");
      const result = spawnSync(process.execPath, [cli, "--format", "json", ...targets], {
        cwd: packageRoot,
        timeout,
        maxBuffer: remainingOutput,
      });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null, result.stderr?.toString("utf8"));
      assert.equal(result.status, expectedStatus);
      remainingOutput -= result.stdout.length + result.stderr.length;
      assert.ok(remainingOutput >= 0, "ESLint phase exceeded 4 MiB of combined output");
      const groupRows = JSON.parse(result.stdout.toString("utf8"));
      assert.deepEqual(groupRows.map(({ filePath }) => filePath).sort(), [...targets].sort());
      rows.push(...groupRows);
      assert.ok(performance.now() <= deadline, "ESLint phase exceeded 60 seconds");
    }
    return { rows };
  };
  try {
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, deprecated);
    }
    const rejected = lint(1);
    assert.equal(rejected.rows.length, paths.length + existingPaths.length);
    for (const row of rejected.rows) {
      if (existingPaths.includes(row.filePath)) {
        assert.equal(row.errorCount, 0, JSON.stringify(row.messages));
        assert.equal(row.fatalErrorCount, 0);
        continue;
      }
      const errors = row.messages.filter(({ severity }) => severity === 2);
      assert.ok(errors.length >= 3, `${row.filePath}: ${JSON.stringify(row.messages)}`);
      assert.ok(errors.every(({ ruleId }) => ruleId === "@typescript-eslint/no-deprecated"));
      assert.ok(errors.some(({ message }) => message.includes("legacyApi")));
      assert.ok(errors.some(({ message }) => message.includes("parse")));
      assert.ok(errors.some(({ message }) => message.includes("caretRangeFromPoint")));
    }
    for (const path of paths) writeFileSync(path, supported);
    const accepted = lint(0);
    assert.equal(accepted.rows.length, paths.length + existingPaths.length);
    assert.ok(accepted.rows.every(({ errorCount, fatalErrorCount }) => errorCount === 0 && fatalErrorCount === 0));
  } finally {
    for (const path of paths) rmSync(path, { force: true });
  }
}
