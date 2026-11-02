import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShellEnvironment, readShellEnvironment, shellEnvironmentCommand } from "./shellEnvironment";

const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "alook-shell-env-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("fresh local shell environment", () => {
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
    const command = shellEnvironmentCommand({ SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\test", SECRET_OLD: "private" }, "win32");
    expect(command.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(command.env).not.toHaveProperty("SECRET_OLD");
    expect(command.args.join(" ")).toContain("GetEnvironmentVariables('User')");
    const fresh = parseShellEnvironment(Buffer.from('__ALOOK_ENV_V1__{"Path":"C:\\\\Windows","UserProfile":"C:\\\\Users\\\\test","Token":"line1\\nline2"}'), "win32");
    expect(fresh.PATH).toBe("C:\\Windows");
    expect(fresh.TOKEN).toBe("line1\nline2");
  });
});
