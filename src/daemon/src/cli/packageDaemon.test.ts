import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageDaemonArgs } from "../../scripts/daemon";

describe("package-local daemon entry", () => {
  it("delegates every argument to the canonical daemon parser", () => {
    expect(packageDaemonArgs(["start", "--machine-key", "cmk_x"])).toEqual([
      "daemon", "start", "--machine-key", "cmk_x",
    ]);
    expect(packageDaemonArgs(["start", "--foreground", "--machine-key", "cmk_x"])).toEqual([
      "daemon", "start", "--foreground", "--machine-key", "cmk_x",
    ]);
    expect(packageDaemonArgs(["unknown"])).toEqual(["daemon", "unknown"]);
  });

  it("contains no second Commander or direct daemonStart call", () => {
    const source = readFileSync(fileURLToPath(new URL("../../scripts/daemon.ts", import.meta.url)), "utf8");
    expect(source).not.toContain('from "commander"');
    expect(source).not.toContain("daemonStart(");
  });
});
