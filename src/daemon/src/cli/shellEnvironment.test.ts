import { afterEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
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
    const capture = readShellEnvironment({ env: { HOME: dir, SHELL: shell }, timeoutMs: 100 });
    await expect(capture).rejects.toThrow(/^environment_unavailable$/);
    await expect(capture).rejects.toHaveProperty("cause", "timeout");
    expect(Date.now() - before).toBeLessThan(3000);
  });

  it("rejects unframed or malformed environments", () => {
    for (const value of ["HOME=/tmp\0PATH=/bin\0", "__ALOOK_ENV_V1__\0bad\0", "__ALOOK_ENV_V1__\0HOME=/tmp\0"]) {
      expect(() => parseShellEnvironment(Buffer.from(value), "darwin")).toThrow();
    }
  });

  it.each([
    { script: "process.stdout.write('PRIVATE_BAD_FRAME')", cause: "parse" },
    { script: "process.exit(7)", cause: "exit" },
  ])("rejects malformed or unsuccessful child capture without exposing its contents: $cause", async ({ script, cause }) => {
    const spawnProcess = (() => spawn(process.execPath, ["-e", script],
      { stdio: ["ignore", "pipe", "ignore"] })) as typeof spawn;
    const capture = readShellEnvironment({ spawnProcess });
    await expect(capture).rejects.toThrow(/^environment_unavailable$/);
    await expect(capture).rejects.toHaveProperty("cause", cause);
  });

  it("rejects a missing shell executable without exposing local paths", async () => {
    const dir = fixture();
    const capture = readShellEnvironment({ env: { SystemRoot: dir, USERPROFILE: dir, HOME: dir, SHELL: join(dir, "missing-shell") } });
    await expect(capture).rejects.toThrow(/^environment_unavailable$/);
    await expect(capture).rejects.toHaveProperty("cause", "child_error");
  });

  it("rejects oversized output even when additional buffered chunks arrive after failure", async () => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    Object.assign(child, { stdout: new EventEmitter() });
    const capture = readShellEnvironment({ spawnProcess: (() => child) as typeof spawn });
    const pending = expect(capture).rejects.toThrow(/^environment_unavailable$/);
    child.stdout!.emit("data", Buffer.alloc(1024 * 1024 + 1));
    child.stdout!.emit("data", Buffer.from("buffered-after-failure"));
    child.emit("error", new Error("PRIVATE_LATER_CHILD_ERROR"));
    child.emit("close", null);
    await pending;
    await expect(capture).rejects.toHaveProperty("cause", "output_limit");
  });

  it.runIf(process.platform !== "win32")("falls back to terminating only its owned child when group termination fails", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("fixture group unavailable"); });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const spawnProcess = (() => { child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"],
        { stdio: ["ignore", "pipe", "ignore"] }); return child; }) as typeof spawn;
      await expect(readShellEnvironment({ spawnProcess, timeoutMs: 100 })).rejects.toThrow(/^environment_unavailable$/);
      expect(kill).toHaveBeenCalledWith(-child!.pid!, "SIGKILL");
      expect(child!.signalCode).toBe("SIGKILL");
    } finally { kill.mockRestore(); child?.kill("SIGKILL"); }
  });

  it("bounds the Windows process-tree cleanup path against its own child", async () => {
    let ownedChild: ReturnType<typeof spawn> | undefined;
    const spawnProcess = (() => {
      ownedChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      return ownedChild;
    }) as typeof spawn;
    try {
      const capture = readShellEnvironment({ platform: "win32", spawnProcess, timeoutMs: 100 });
      await expect(capture).rejects.toThrow(/^environment_unavailable$/);
      await expect(capture).rejects.toHaveProperty("cause", "timeout");
      expect(ownedChild).toBeDefined();
      expect(ownedChild!.exitCode !== null || ownedChild!.signalCode !== null).toBe(true);
    } finally { ownedChild?.kill("SIGKILL"); }
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
    const prefix = "alook:shell-profile:";
    let completedStages: ReturnType<typeof performance.getEntriesByType> | undefined;
    onTestFailed(() => {
      const stages = completedStages ?? performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith(prefix));
      console.info("ALOOK_QA_STAGES", JSON.stringify({
        snapshot: completedStages ? "callback_finally" : "failure_hook_after_fixture_cleanup",
        observedAtMs: performance.now(),
        stages: stages.map((entry) => ({ stage: entry.name, startTimeMs: entry.startTime })),
      }));
    });
    performance.mark(`${prefix}start`);
    const spawnProcess = ((file, args, options) => {
      const configured = [...args];
      configured[configured.length - 1] = "$PROFILE=[pscustomobject]@{AllUsersAllHosts=" + quotedMissing + ";AllUsersCurrentHost=" + quotedMissing + ";CurrentUserAllHosts=" + quotedProfile + ";CurrentUserCurrentHost=" + quotedMissing + "}; " + configured.at(-1);
      configured[configured.length - 1] = "try { " + configured.at(-1) + " } catch { [Console]::Error.Write('ALOOK_QA_FAILURE='+$_.Exception.GetType().Name+':'+$_.CategoryInfo.Category+':'+$_.InvocationInfo.OffsetInLine); exit 1 }";
      const child = spawn(file, configured, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      child.once("spawn", () => performance.mark(`${prefix}child.${child.pid}.spawn`));
      child.once("error", () => performance.mark(`${prefix}spawn.error`));
      child.once("close", (code, signal) => {
        termination = `exit=${code}, signal=${signal}, elapsedMs=${Date.now() - started}`;
        performance.mark(`${prefix}child.${child.pid}.close`);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const match = chunk.toString("utf8").match(/ALOOK_QA_FAILURE=([A-Za-z]+:[A-Za-z]+:\d+)/);
        if (match) failure = match[1];
      });
      return child;
    }) as typeof spawn;
    const capture = () => readShellEnvironment({ env: { ...process.env, ALOOK_REFRESH_OLD_FIXTURE: "old" }, spawnProcess, timeoutMs: 10000 });
    try {
      const fresh = await capture().catch((error: unknown) => {
        const cause = error instanceof Error && typeof error.cause === "string"
          && ["child_error", "timeout", "output_limit", "exit", "parse"].includes(error.cause)
          ? error.cause : "unknown";
        performance.mark(`${prefix}capture.failed.${cause}`);
        throw new Error(`PowerShell fixture failed (cause=${cause}; ${termination}; diagnostic=${failure})`);
      });
      performance.mark(`${prefix}capture.complete`);
      performance.mark(`${prefix}unicode.before`);
      expect(fresh.ALOOK_REFRESH_UNICODE).toBe("你好\nline=$literal");
      performance.mark(`${prefix}unicode.after`);
      expect(fresh.ALOOK_REFRESH_OLD_FIXTURE).toBeUndefined();
      performance.mark(`${prefix}removed-export.after`);
      expect(fresh.USERNAME).toBe(process.env.USERNAME);
      performance.mark(`${prefix}username.after`);
      expect(fresh.USERPROFILE).toBe(process.env.USERPROFILE);
      performance.mark(`${prefix}userprofile.after`);
      expect(fresh.PATH).not.toMatch(/;$/);
      performance.mark(`${prefix}path.after`);
    } finally {
      completedStages = performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith(prefix));
      for (const entry of completedStages) performance.clearMarks(entry.name);
    }
  }, 25000);
});
