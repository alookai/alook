import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecSync = vi.fn();
vi.mock("child_process", () => ({ execSync: (...a: unknown[]) => mockExecSync(...a) }));
vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: "/tmp/alook-test" }));

import { runMigrations } from "../src/lib/migrate.js";

let logs: string[];
beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("runMigrations", () => {
  it("sums applied command counts from wrangler output", () => {
    mockExecSync.mockReturnValue(Buffer.from("3 commands executed successfully\n5 commands executed successfully"));
    runMigrations();
    expect(logs.join("\n")).toContain("8 migration commands applied");
  });

  it("reports up-to-date when there is nothing to apply", () => {
    mockExecSync.mockReturnValue(Buffer.from("No migrations to apply"));
    runMigrations();
    expect(logs.join("\n")).toContain("Already up to date");
  });

  it("falls back to a generic 'complete' message for unrecognized output", () => {
    mockExecSync.mockReturnValue(Buffer.from("some other output"));
    runMigrations();
    expect(logs.join("\n")).toContain("Migrations complete");
  });

  it("exits on migration failure", () => {
    mockExecSync.mockImplementation(() => { const e = new Error("fail") as Error & { stderr?: Buffer }; e.stderr = Buffer.from("D1 error"); throw e; });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    expect(() => runMigrations()).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
