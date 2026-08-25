import { describe, expect, it } from "vitest";
import {
  createWindowsCommandInvocation,
  TRUSTED_WINDOWS_COMMAND_PROCESSOR,
} from "../src/lib/windows-command.js";

function filesystem(options: {
  existing?: string[];
  files?: string[];
  realpaths?: Record<string, string>;
} = {}) {
  const existing = new Set(options.existing ?? []);
  const files = new Set(options.files ?? options.existing ?? []);
  return {
    exists: (path: string) => existing.has(path),
    isFile: (path: string) => files.has(path),
    realpath: (path: string) => options.realpaths?.[path] ?? path,
  };
}

describe("trusted Windows command shim", () => {
  it("ignores every ComSpec casing and PATH-shadowed cmd.exe", () => {
    const shim = String.raw`C:\fake bin\npx.cmd`;
    const fakeCmd = String.raw`C:\attacker\cmd.exe`;
    const fs = filesystem({ existing: [shim, TRUSTED_WINDOWS_COMMAND_PROCESSOR], files: [shim, TRUSTED_WINDOWS_COMMAND_PROCESSOR] });
    const invocation = createWindowsCommandInvocation("npx", ["wrangler", "dev"], {
      PATH: String.raw`C:\fake bin`,
      ComSpec: fakeCmd,
      COMSPEC: fakeCmd,
      cOmSpEc: fakeCmd,
      SystemRoot: String.raw`C:\attacker`,
    }, fs);

    expect(invocation.command).toBe(TRUSTED_WINDOWS_COMMAND_PROCESSOR);
    expect(invocation.command).not.toBe(fakeCmd);
    expect(invocation.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
  });

  it("quotes spaces and shell metacharacters without enabling a generic shell", () => {
    const shim = String.raw`C:\Program Files\node & tools\npx.cmd`;
    const fs = filesystem({ existing: [shim, TRUSTED_WINDOWS_COMMAND_PROCESSOR], files: [shim, TRUSTED_WINDOWS_COMMAND_PROCESSOR] });
    const invocation = createWindowsCommandInvocation(shim, ["a&b", "c|d", "e<f", "g>h", "i^j", "k(l)", "m%n", "o!p"], {}, fs);

    expect(invocation).toEqual({
      command: TRUSTED_WINDOWS_COMMAND_PROCESSOR,
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        String.raw`""C:\Program Files\node & tools\npx.cmd" "a&b" "c|d" "e<f" "g>h" "i^j" "k(l)" "m%%n" "o!p""`,
      ],
    });
  });

  it("rejects arbitrary cmd shims before command execution", () => {
    const other = String.raw`C:\tools\worker.cmd`;
    const fs = filesystem({ existing: [other, TRUSTED_WINDOWS_COMMAND_PROCESSOR], files: [other, TRUSTED_WINDOWS_COMMAND_PROCESSOR] });
    expect(() => createWindowsCommandInvocation(other, [], {}, fs)).toThrow("refusing untrusted Windows command shim");
  });

  it("rejects missing PATH resolution, relative shims, and quoted arguments", () => {
    expect(() => createWindowsCommandInvocation("npx", [], {}, filesystem()))
      .toThrow("could not resolve internal Windows npx.cmd shim");
    expect(() => createWindowsCommandInvocation("npx.cmd", [], {}, filesystem()))
      .toThrow("not an absolute regular file");
    const shim = String.raw`C:\bin\npx.cmd`;
    const fs = filesystem({ existing: [shim, TRUSTED_WINDOWS_COMMAND_PROCESSOR], files: [shim, TRUSTED_WINDOWS_COMMAND_PROCESSOR] });
    expect(() => createWindowsCommandInvocation(shim, ['bad"arg'], {}, fs))
      .toThrow("unsupported control character or quote");
  });

  it.each([
    {
      label: "realpath drift",
      fs: filesystem({
        existing: [String.raw`C:\bin\npx.cmd`, TRUSTED_WINDOWS_COMMAND_PROCESSOR],
        files: [String.raw`C:\bin\npx.cmd`, String.raw`C:\attacker\cmd.exe`],
        realpaths: { [TRUSTED_WINDOWS_COMMAND_PROCESSOR]: String.raw`C:\attacker\cmd.exe` },
      }),
      expected: "canonical regular-file validation",
    },
    {
      label: "missing trusted processor",
      fs: filesystem({ existing: [String.raw`C:\bin\npx.cmd`], files: [String.raw`C:\bin\npx.cmd`] }),
      expected: "trusted Windows command processor is missing",
    },
    {
      label: "non-regular trusted processor",
      fs: filesystem({
        existing: [String.raw`C:\bin\npx.cmd`, TRUSTED_WINDOWS_COMMAND_PROCESSOR],
        files: [String.raw`C:\bin\npx.cmd`],
      }),
      expected: "canonical regular-file validation",
    },
  ])("fails closed for $label", ({ fs, expected }) => {
    expect(() => createWindowsCommandInvocation(String.raw`C:\bin\npx.cmd`, [], {}, fs)).toThrow(expected);
  });

  it("keeps non-shim executables on the direct spawn path", () => {
    expect(createWindowsCommandInvocation(String.raw`C:\nodejs\node.exe`, ["app.js"], {
      ComSpec: String.raw`C:\attacker\cmd.exe`,
    }, filesystem())).toEqual({ command: String.raw`C:\nodejs\node.exe`, args: ["app.js"] });
  });
});
