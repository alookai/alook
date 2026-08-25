import { describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => {
  const native = vi.fn((path: string) => path);
  const realpathSync = Object.assign(vi.fn((path: string) => path), { native });
  return {
    existsSync: vi.fn(() => true),
    realpathSync,
    statSync: vi.fn(() => ({ isFile: () => true })),
  };
});

vi.mock("node:fs", () => fsMocks);

import {
  createWindowsCommandInvocation,
  TRUSTED_WINDOWS_COMMAND_PROCESSOR,
} from "../src/lib/windows-command.js";

describe("production Windows command filesystem adapter", () => {
  it("canonicalizes and validates both the internal shim and trusted processor", () => {
    const invocation = createWindowsCommandInvocation("npx", ["--version"], { PATH: String.raw`C:\bin` });
    expect(invocation.command).toBe(TRUSTED_WINDOWS_COMMAND_PROCESSOR);
    expect(fsMocks.realpathSync.native).toHaveBeenCalledWith(String.raw`C:\bin\npx.cmd`);
    expect(fsMocks.realpathSync.native).toHaveBeenCalledWith(TRUSTED_WINDOWS_COMMAND_PROCESSOR);
    expect(fsMocks.statSync).toHaveBeenCalled();
  });
});
