import { describe, expect, it } from "vitest";
import { resolvePackageManagerCommand } from "./test-package-manager.js";

describe("resolvePackageManagerCommand", () => {
  it("runs a JavaScript lifecycle entrypoint through Node", () => {
    expect(resolvePackageManagerCommand(
      ["run", "build"],
      { npm_execpath: "C:\\tools\\pnpm.cjs" },
      "C:\\tools\\node.exe",
      "win32",
    )).toEqual({
      file: "C:\\tools\\node.exe",
      args: ["C:\\tools\\pnpm.cjs", "run", "build"],
    });
  });

  it("uses the Windows command shell for a pnpm cmd shim", () => {
    expect(resolvePackageManagerCommand(
      ["pack"],
      { npm_execpath: "C:\\tools\\pnpm.cmd" },
      "C:\\tools\\node.exe",
      "win32",
    )).toEqual({
      file: "C:\\tools\\pnpm.cmd",
      args: ["pack"],
      shell: true,
    });
  });

  it("runs a native lifecycle executable directly", () => {
    expect(resolvePackageManagerCommand(
      ["pack"],
      { npm_execpath: "/tools/pnpm" },
      "/tools/node",
      "linux",
    )).toEqual({
      file: "/tools/pnpm",
      args: ["pack"],
    });
  });

  it("uses a shell-backed PATH fallback on Windows", () => {
    expect(resolvePackageManagerCommand(["pack"], {}, "C:\\tools\\node.exe", "win32")).toEqual({
      file: "pnpm",
      args: ["pack"],
      shell: true,
    });
  });

  it("uses a direct PATH fallback on POSIX", () => {
    expect(resolvePackageManagerCommand(["pack"], {}, "/tools/node", "linux")).toEqual({
      file: "pnpm",
      args: ["pack"],
    });
  });
});
