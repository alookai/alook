import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const apiDirectory = resolve(process.cwd(), "src/daemon/agent-driver/etc/api");

describe("agent-driver API reports", () => {
  it.each(["root", "host", "adapter-author", "testing"])("has no hidden exported dependency in %s", (name) => {
    const report = readFileSync(resolve(apiDirectory, `${name}.api.md`), "utf8");
    expect(report).not.toContain("ae-forgotten-export");
  });

  it("captures transitively exposed adapter-author input shapes", () => {
    const report = readFileSync(resolve(apiDirectory, "adapter-author.api.md"), "utf8");
    expect(report).toContain("export interface AdapterLaunchConfig");
    expect(report).toContain("runtimeConfig?: Config;");
    expect(report).toContain("export type InputMode = \"busy\" | \"idle\";");
  });
});
