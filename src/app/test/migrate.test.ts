import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecFileSync = vi.fn();
vi.mock("child_process", () => ({ execFileSync: (...a: unknown[]) => mockExecFileSync(...a) }));
vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: "/tmp/alook-test" }));
vi.mock("../src/lib/wrangler.js", () => ({
  wranglerProcess: (args: string[]) => ({ command: "/node", args: ["/wrangler.js", ...args] }),
}));

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
    mockExecFileSync.mockReturnValue(Buffer.from("3 commands executed successfully\n5 commands executed successfully"));
    runMigrations();
    expect(logs.join("\n")).toContain("8 migration commands applied");
    expect(mockExecFileSync).toHaveBeenCalledWith("/node", expect.any(Array), expect.objectContaining({
      maxBuffer: 32 * 1024 * 1024,
    }));
  });

  it("reports up-to-date when there is nothing to apply", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("No migrations to apply"));
    runMigrations();
    expect(logs.join("\n")).toContain("Already up to date");
  });

  it("falls back to a generic 'complete' message for unrecognized output", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("some other output"));
    runMigrations();
    expect(logs.join("\n")).toContain("Migrations complete");
  });

  it("throws on migration failure so the lifecycle reservation can unwind", () => {
    mockExecFileSync.mockImplementation(() => { const e = new Error("fail") as Error & { stderr?: Buffer }; e.stderr = Buffer.from("D1 error"); throw e; });
    expect(() => runMigrations()).toThrow("failed to run migrations");
  });
});
