import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
import { isCommandAvailable, detectRuntimes } from "./runtimes.js";

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isCommandAvailable", () => {
  it("returns true when command exists", () => {
    mockedExecSync.mockReturnValue("");
    expect(isCommandAvailable("claude")).toBe(true);
  });

  it("returns false when command does not exist", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(isCommandAvailable("nonexistent")).toBe(false);
  });

  it("uses 'which' on non-windows platforms", () => {
    mockedExecSync.mockReturnValue("");
    isCommandAvailable("claude");
    expect(mockedExecSync).toHaveBeenCalledWith("which claude", { stdio: "ignore" });
  });
});

describe("detectRuntimes", () => {
  it("returns empty array when no runtimes found", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detectRuntimes()).toEqual([]);
  });

  it("detects available runtimes with versions", () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which claude") return "";
      if (cmd === "claude --version") return "1.0.0\n";
      if (cmd === "which codex") return "";
      if (cmd === "codex --version") return "2.0.0\n";
      if (cmd === "which opencode") return "";
      if (cmd === "opencode --version") return "3.0.0\n";
      throw new Error("not found");
    });

    const result = detectRuntimes();
    expect(result).toEqual([
      { type: "claude", version: "1.0.0" },
      { type: "codex", version: "2.0.0" },
      { type: "opencode", version: "3.0.0" },
    ]);
  });

  it("includes runtime with empty version when --version fails", () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which claude") return "";
      if (cmd === "claude --version") throw new Error("no version");
      throw new Error("not found");
    });

    const result = detectRuntimes();
    expect(result).toEqual([{ type: "claude", version: "" }]);
  });

  it("only checks claude, codex, opencode", () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "which claude") return "";
      if (cmd === "claude --version") return "1.0.0\n";
      throw new Error("not found");
    });

    const result = detectRuntimes();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("claude");
  });
});
