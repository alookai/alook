import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeCliLink, writeWindowsBashEnv } from "./cliLink.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "clilink-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("writeCliLink (POSIX symlink)", () => {
  it("creates a symlink bin/<cliName> -> hostCliPath that resolves through", () => {
    const stateDir = mkTmp();
    const host = path.join(stateDir, "real-cli.js");
    fs.writeFileSync(host, "#!/usr/bin/env node\n", { mode: 0o755 });

    const binDir = writeCliLink(stateDir, "alook", host, "linux");
    const link = path.join(binDir, "alook");

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(host));
  });

  it("is idempotent (unlink-then-link) across repeated launches", () => {
    const stateDir = mkTmp();
    const host = path.join(stateDir, "cli.js");
    fs.writeFileSync(host, "x");

    const binDir = writeCliLink(stateDir, "alook", host, "linux");
    expect(() => writeCliLink(stateDir, "alook", host, "linux")).not.toThrow();
    expect(fs.lstatSync(path.join(binDir, "alook")).isSymbolicLink()).toBe(true);
  });

  it("creates no link in mock mode (no hostCliPath), only the bin dir", () => {
    const stateDir = mkTmp();
    const binDir = writeCliLink(stateDir, "alook", undefined, "linux");
    expect(fs.existsSync(binDir)).toBe(true);
    expect(fs.existsSync(path.join(binDir, "alook"))).toBe(false);
  });
});

describe("writeCliLink (Windows .cmd shim)", () => {
  it.each(["index.js", "index.cjs", "index.MJS"])("runs %s with the daemon's Node executable", filename => {
    const stateDir = mkTmp();
    const host = `C:\\host with spaces\\${filename}`;
    const binDir = writeCliLink(stateDir, "alook", host, "win32");
    expect(fs.readFileSync(path.join(binDir, "alook.cmd"), "utf8"))
      .toBe(`@echo off\r\n"${process.execPath}" "${host}" %*\r\n`);
  });

  it("writes a .cmd shim forwarding to hostCliPath", () => {
    const stateDir = mkTmp();
    const host = "C:\\host\\alook.exe";
    const binDir = writeCliLink(stateDir, "alook", host, "win32");
    const cmd = path.join(binDir, "alook.cmd");
    expect(fs.existsSync(cmd)).toBe(true);
    const body = fs.readFileSync(cmd, "utf8");
    expect(body).toContain(`"${host}" %*`);
    expect(fs.readFileSync(path.join(binDir, "alook"), "utf8"))
      .toBe("#!/bin/sh\nMSYS2_ARG_CONV_EXCL='*' exec 'C:/host/alook.exe' \"$@\"\n");
    expect(fs.lstatSync(path.join(binDir, "alook")).isSymbolicLink()).toBe(false);
  });

  it("quotes shell metacharacters in the Bash launcher without changing arguments", () => {
    const binDir = writeCliLink(mkTmp(), "house", "C:\\host's $directory\\index.js", "win32");
    const body = fs.readFileSync(path.join(binDir, "house"), "utf8");
    expect(body).toContain("'C:/host'\\''s $directory/index.js' \"$@\"");
  });

  it("sources an existing Bash startup file before selecting the shell's launcher", () => {
    const binDir = path.join(mkTmp(), "bin");
    fs.mkdirSync(binDir);
    const startup = writeWindowsBashEnv(binDir, "house", "HOUSE", "C:\\user's home\\startup.sh");
    expect(fs.readFileSync(startup, "utf8")).toBe(`. 'C:/user'\\''s home/startup.sh'\nexport 'HOUSE_CLI=${binDir.replaceAll("\\", "/")}/house'\n`);
    expect(() => writeWindowsBashEnv(binDir, "house", "HOUSE", startup)).not.toThrow();
    expect(fs.readFileSync(startup, "utf8")).not.toContain(`. '${startup}'`);
  });

  it("creates no shim in mock mode on Windows", () => {
    const stateDir = mkTmp();
    const binDir = writeCliLink(stateDir, "alook", undefined, "win32");
    expect(fs.existsSync(path.join(binDir, "alook.cmd"))).toBe(false);
  });
});
