import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const adapterProbe = resolve(packageRoot, "src/adapters/__gate__.ts");

describe("adapter process-spawn authority lint", () => {
  it.each([
    ["named import", 'import { spawn } from "node:child_process"; void spawn;'],
    ["namespace import", 'import * as cp from "node:child_process"; void cp.spawn;'],
    ["default import", 'import cp from "child_process"; void cp.spawn;'],
    ["dynamic import", 'import("node:child_process").then((cp) => cp.spawn);'],
  ])("rejects the %s bypass", async (_label, source) => {
    const eslint = new ESLint({ cwd: packageRoot });
    const [result] = await eslint.lintText(source, { filePath: adapterProbe });

    expect(result?.errorCount).toBeGreaterThan(0);
    expect(result?.messages.some((message) =>
      message.ruleId === "no-restricted-imports" || message.ruleId === "no-restricted-syntax",
    )).toBe(true);
  });
});
