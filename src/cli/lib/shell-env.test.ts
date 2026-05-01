import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("./platform.js", () => ({
  isWindows: false,
}));

const mockedExecSync = vi.mocked(execSync);

describe("resolveLoginShellEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/bin/zsh", PATH: "/usr/bin" };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("calls shell with -ilc flag to source .zshrc", async () => {
    mockedExecSync.mockReturnValue("PATH=/usr/bin:/new/path\nHOME=/Users/test\n");
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    resolveLoginShellEnv();
    expect(mockedExecSync).toHaveBeenCalledWith(
      "/bin/zsh -ilc 'env'",
      expect.objectContaining({ encoding: "utf-8", timeout: 5000 }),
    );
  });

  it("uses interactive flag so .zshrc PATH additions are picked up", async () => {
    mockedExecSync.mockReturnValue(
      "HOME=/Users/test\nPATH=/usr/bin:/Users/test/.opencode/bin\nSHELL=/bin/zsh\n",
    );
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    const env = resolveLoginShellEnv();
    expect(env.PATH).toContain("/Users/test/.opencode/bin");
  });

  it("falls back to process.env when shell command fails", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    const env = resolveLoginShellEnv();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("falls back to process.env when output has no PATH", async () => {
    mockedExecSync.mockReturnValue("HOME=/Users/test\nUSER=test\n");
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    const env = resolveLoginShellEnv();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("parses multiline env output correctly", async () => {
    mockedExecSync.mockReturnValue(
      "HOME=/Users/gener\nPATH=/opt/homebrew/bin:/usr/bin\nSHELL=/bin/zsh\nLANG=en_US.UTF-8\n",
    );
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    const env = resolveLoginShellEnv();
    expect(env.HOME).toBe("/Users/gener");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("uses default /bin/zsh when SHELL is not set", async () => {
    delete process.env.SHELL;
    mockedExecSync.mockReturnValue("PATH=/usr/bin\n");
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    resolveLoginShellEnv();
    expect(mockedExecSync).toHaveBeenCalledWith(
      "/bin/zsh -ilc 'env'",
      expect.anything(),
    );
  });

  it("respects custom SHELL env var", async () => {
    process.env.SHELL = "/bin/bash";
    mockedExecSync.mockReturnValue("PATH=/usr/bin\n");
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    resolveLoginShellEnv();
    expect(mockedExecSync).toHaveBeenCalledWith(
      "/bin/bash -ilc 'env'",
      expect.anything(),
    );
  });
});

describe("resolveLoginShellEnv (windows)", () => {
  it("returns process.env copy on Windows", async () => {
    vi.doMock("./platform.js", () => ({ isWindows: true }));
    vi.resetModules();
    mockedExecSync.mockClear();
    const { resolveLoginShellEnv } = await import("./shell-env.js");
    const env = resolveLoginShellEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});
