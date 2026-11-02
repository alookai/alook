import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseShellEnvironment, readShellEnvironment, shellEnvironmentCommand } from "./shellEnvironment";

const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alook-shell-env-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("fresh local shell environment", () => {
  for (const name of ["bash", "zsh", "csh", "tcsh"]) {
    const shell = "/bin/" + name;
    it.runIf(process.platform === "darwin" && existsSync(shell))(`loads native ${name} login and interactive startup configuration`, async () => {
      const dir = fixture();
      if (name === "bash") {
        writeFileSync(join(dir, ".bash_profile"), "export ALOOK_LOGIN_PROFILE=loaded\n. \"$HOME/.bashrc\"\n");
        writeFileSync(join(dir, ".bashrc"), "export ALOOK_INTERACTIVE_RC=loaded\n");
      } else if (name === "zsh") {
        writeFileSync(join(dir, ".zprofile"), "export ALOOK_LOGIN_PROFILE=loaded\n");
        writeFileSync(join(dir, ".zshrc"), "export ALOOK_INTERACTIVE_RC=loaded\n");
      } else {
        writeFileSync(join(dir, ".login"), "setenv ALOOK_LOGIN_PROFILE loaded\n");
        for (const rc of [".cshrc", ".tcshrc"]) writeFileSync(join(dir, rc), "setenv ALOOK_INTERACTIVE_RC loaded\n");
      }
      const fresh = await readShellEnvironment({ env: { ...process.env, HOME: dir, ZDOTDIR: dir, SHELL: shell, ALOOK_REMOVED_EXPORT: "stale" } });
      expect(fresh.ALOOK_LOGIN_PROFILE).toBe("loaded");
      expect(fresh.ALOOK_INTERACTIVE_RC).toBe("loaded");
      expect(fresh.ALOOK_REMOVED_EXPORT).toBeUndefined();
    });
  }
  it.runIf(process.platform !== "win32")("reads changed exports and literal multiline values while dropping deleted inherited exports", async () => {
    const dir = fixture();
    const shell = join(dir, "shell");
    const config = join(dir, "exports");
    writeFileSync(shell, `#!/bin/sh\n. '${config}'\nprintf 'startup banner\\n__ALOOK_ENV_V1__\\000'\nexec /usr/bin/env -0\n`, { mode: 0o700 });
    writeFileSync(config, "export ALOOK_SYNTHETIC_REFRESH='first'\n");
    const input = { ...process.env, HOME: dir, SHELL: shell, OLD_ONLY: "stale-private-value" };
    expect((await readShellEnvironment({ env: input })).ALOOK_SYNTHETIC_REFRESH).toBe("first");
    writeFileSync(config, "export ALOOK_SYNTHETIC_REFRESH='second\n你好=$literal'\n");
    const fresh = await readShellEnvironment({ env: input });
    expect(fresh.ALOOK_SYNTHETIC_REFRESH).toBe("second\n你好=$literal");
    expect(fresh.OLD_ONLY).toBeUndefined();
    expect(input.OLD_ONLY).toBe("stale-private-value");
  });

  it.runIf(process.platform !== "win32")("bounds a stalled shell and never returns raw output in the error", async () => {
    const dir = fixture();
    const shell = join(dir, "shell");
    writeFileSync(shell, "#!/bin/sh\necho secret-environment-value\necho private-stderr >&2\nsleep 60\n", { mode: 0o700 });
    const before = Date.now();
    await expect(readShellEnvironment({ env: { HOME: dir, SHELL: shell }, timeoutMs: 100 }))
      .rejects.toThrow(/^environment_unavailable$/);
    expect(Date.now() - before).toBeLessThan(3000);
  });

  it("rejects unframed or malformed environments", () => {
    for (const value of ["HOME=/tmp\0PATH=/bin\0", "__ALOOK_ENV_V1__\0bad\0", "__ALOOK_ENV_V1__\0HOME=/tmp\0"]) {
      expect(() => parseShellEnvironment(Buffer.from(value), "darwin")).toThrow();
    }
  });

  it.runIf(process.platform !== "win32")("fills a missing GUI shell from the local account", () => {
    const command = shellEnvironmentCommand({ HOME: "/tmp", SHELL: "" }, process.platform);
    expect(command.file.startsWith("/")).toBe(true);
    expect(command.env.SHELL).toBe(command.file);
  });

  it("normalizes Windows names and rebuilds registry environment before loading profiles", () => {
    const command = shellEnvironmentCommand({ SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\test", USERNAME: "test", USERDOMAIN: "local", SECRET_OLD: "private" }, "win32");
    expect(command.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(command.env).not.toHaveProperty("SECRET_OLD");
    expect(command.env).toMatchObject({ USERNAME: "test", USERDOMAIN: "local" });
    expect(command.args.join(" ")).toContain("GetEnvironmentVariables('User')");
    expect(command.args.join(" ")).toContain("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)");
    const fresh = parseShellEnvironment(Buffer.from('__ALOOK_ENV_V1__{"Path":"C:\\\\Windows","UserProfile":"C:\\\\Users\\\\test","Token":"line1\\nline2"}'), "win32");
    expect(fresh.PATH).toBe("C:\\Windows");
    expect(fresh.TOKEN).toBe("line1\nline2");
  });

  it.runIf(process.platform === "win32")("captures real PowerShell profile Unicode through UTF-8 and removes old exports", async () => {
    const dir = fixture();
    const profile = join(dir, "profile.ps1");
    writeFileSync(profile, "\ufeff$env:ALOOK_REFRESH_UNICODE='你好\nline=$literal'\n$env:Path=(Join-Path $env:SystemRoot 'System32')+';'\nWrite-Output 'profile startup banner'\n");
    const quotedProfile = "'" + profile.replaceAll("'", "''") + "'";
    const quotedMissing = "'" + join(dir, "missing.ps1").replaceAll("'", "''") + "'";
    let failure = "unavailable";
    let termination = "not closed";
    const started = Date.now();
    const spawnProcess = ((file, args, options) => {
      const configured = [...args];
      configured[configured.length - 1] = "try { $PROFILE=[pscustomobject]@{AllUsersAllHosts=" + quotedMissing + ";AllUsersCurrentHost=" + quotedMissing + ";CurrentUserAllHosts=" + quotedProfile + ";CurrentUserCurrentHost=" + quotedMissing + "}; " + configured.at(-1) + " } catch { [Console]::Error.Write('ALOOK_QA_FAILURE='+$_.Exception.GetType().Name+':'+$_.CategoryInfo.Category+':'+$_.InvocationInfo.OffsetInLine); exit 1 }";
      const child = spawn(file, configured, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      child.once("close", (code, signal) => { termination = `exit=${code}, signal=${signal}, elapsedMs=${Date.now() - started}`; });
      child.stderr.on("data", (chunk: Buffer) => {
        const match = chunk.toString("utf8").match(/ALOOK_QA_FAILURE=([A-Za-z]+:[A-Za-z]+:\d+)/);
        if (match) failure = match[1];
      });
      return child;
    }) as typeof spawn;
    const fresh = await readShellEnvironment({ env: { ...process.env, ALOOK_REFRESH_OLD_FIXTURE: "old" }, spawnProcess, timeoutMs: 10000 })
      .catch(() => { throw new Error(`PowerShell fixture failed (${failure}; ${termination})`); });
    expect(fresh.ALOOK_REFRESH_UNICODE).toBe("你好\nline=$literal");
    expect(fresh.ALOOK_REFRESH_OLD_FIXTURE).toBeUndefined();
    expect(fresh.USERNAME).toBe(process.env.USERNAME);
    expect(fresh.USERPROFILE).toBe(process.env.USERPROFILE);
    expect(fresh.PATH).not.toMatch(/;$/);
  }, 15000);
});
