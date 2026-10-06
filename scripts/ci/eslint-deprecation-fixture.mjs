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
  const lint = () => {
    const result = spawnSync(process.execPath, [cli, "--format", "json", ...paths, ...existingPaths], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    return { status: result.status, rows: JSON.parse(result.stdout) };
  };
  try {
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, deprecated);
    }
    const rejected = lint();
    assert.equal(rejected.status, 1);
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
    const accepted = lint();
    assert.equal(accepted.status, 0);
    assert.equal(accepted.rows.length, paths.length + existingPaths.length);
    assert.ok(accepted.rows.every(({ errorCount, fatalErrorCount }) => errorCount === 0 && fatalErrorCount === 0));
  } finally {
    for (const path of paths) rmSync(path, { force: true });
  }
}
