import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeCliLink } from "./cliLink";

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
  it("writes a .cmd shim forwarding to hostCliPath", () => {
    const stateDir = mkTmp();
    const host = "C:\\host\\alook.exe";
    const binDir = writeCliLink(stateDir, "alook", host, "win32");
    const cmd = path.join(binDir, "alook.cmd");
    expect(fs.existsSync(cmd)).toBe(true);
    const body = fs.readFileSync(cmd, "utf8");
    expect(body).toContain(`"${host}" %*`);
    // No bare POSIX symlink on Windows.
    expect(fs.existsSync(path.join(binDir, "alook"))).toBe(false);
  });

  it("creates no shim in mock mode on Windows", () => {
    const stateDir = mkTmp();
    const binDir = writeCliLink(stateDir, "alook", undefined, "win32");
    expect(fs.existsSync(path.join(binDir, "alook.cmd"))).toBe(false);
  });
});
