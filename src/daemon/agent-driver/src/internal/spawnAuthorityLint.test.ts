import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const token = randomUUID();
const cases = [
  ["named import", 'import { spawn } from "node:child_process"; void spawn;'],
  ["namespace import", 'import * as cp from "node:child_process"; void cp.spawn;'],
  ["default import", 'import cp from "child_process"; void cp.spawn;'],
  ["dynamic import", 'import("node:child_process").then((cp) => cp.spawn);'],
].map(([label, source], index) => ({
  label: label!, source: source!,
  path: resolve(packageRoot, `src/adapters/__gate_${token}_${index}.ts`),
}));

describe("adapter process-spawn authority lint", () => {
  beforeAll(() => {
    for (const probe of cases) writeFileSync(probe.path, probe.source);
  });
  afterAll(() => {
    for (const probe of cases) rmSync(probe.path, { force: true });
  });
  it.each(cases)("rejects the $label bypass", async ({ path }) => {
    const eslint = new ESLint({ cwd: packageRoot });
    const [result] = await eslint.lintFiles(path);

    expect(result?.fatalErrorCount).toBe(0);
    expect(result?.errorCount).toBeGreaterThan(0);
    expect(result?.messages.some((message) =>
      message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax",
    )).toBe(true);
  });
});
