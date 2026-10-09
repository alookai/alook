import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeLaunchContext, fakePrepared } from "../testing/adapter-fixture.js";
import { prepareCliTransport } from "./cliTransport.js";
import { writeCliLink } from "./cliLink.js";
import { isAlive, killProcessTree, spawnAgentProcess } from "./killTree.js";

async function invoke(command: string, args: string[], cwd: string, shell: boolean,
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) {
  const child = spawnAgentProcess(command, args, { cwd, env: options.env ?? process.env, shell });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const closed = once(child, "close");
  if (options.stdin !== undefined) child.stdin?.end(options.stdin, "utf8");
  const timeout = setTimeout(() => { void killProcessTree(child.pid!).catch(() => {}); }, 30_000);
  try {
    await closed;
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: child.exitCode };
  } finally {
    clearTimeout(timeout);
    if (child.pid && isAlive(child.pid)) await killProcessTree(child.pid);
  }
}

describe.skipIf(process.platform !== "win32")("native Windows injected Node CLI", () => {
  it("executes a Node JS CLI through both its wrapper and actual transport env", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alook Node CLI with spaces-"));
    const host = join(directory, "index.js");
    const marker = "alook-native-node-cli-ready";
    writeFileSync(host, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ marker: ${JSON.stringify(marker)}, args: process.argv.slice(2) }));\n`);
    const expected = JSON.stringify({ marker, args: ["--help"] });
    try {
      const control = await invoke(process.execPath, [host, "--help"], directory, false);
      console.log(JSON.stringify({ stage: "node-control", ...control }));
      expect(control.stdout).toBe(expected);
      expect(control.code).toBe(0);
      const bin = writeCliLink(join(directory, "wrapper"), "alook", host);
      const viaWrapper = await invoke(join(bin, "alook.cmd"), ["--help"], directory, true);
      console.log(JSON.stringify({ stage: "generated-wrapper", ...viaWrapper }));
      expect.soft(viaWrapper.stdout).toBe(expected);
      expect.soft(viaWrapper.code).toBe(0);
      const ctx = fakeLaunchContext("codex", directory, {
        prepared: {
          ...fakePrepared({ base: process.env, platformProtected: { ALOOK_CLI: host }, networkProtected: { PATH: process.env.PATH } }),
          executablePath: host,
        },
      });
      const { spawnEnv } = await prepareCliTransport(ctx);
      expect.soft(spawnEnv.ALOOK_CLI).toMatch(/\.cmd$/i);
      const injected = await invoke(spawnEnv.ALOOK_CLI!, ["--help"], directory, true, { env: spawnEnv });
      console.log(JSON.stringify({ stage: "injected-cli", ...injected }));
      expect.soft(injected.stdout).toBe(expected);
      expect.soft(injected.code).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);

  it("preserves UTF-8 stdin and exit codes through cmd and PowerShell", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alook Windows stdin with spaces-"));
    const host = join(directory, "index.cjs");
    const message = "Windows 中文回复✓ nonce-cli-165";
    writeFileSync(host, "if(process.argv.includes('--fail'))process.exit(23);console.log(require('node:fs').readFileSync(0,'utf8').trimEnd());\n");
    try {
      const ctx = fakeLaunchContext("codex", directory, {
        prepared: {
          ...fakePrepared({ base: process.env, platformProtected: { ALOOK_CLI: host } }),
          executablePath: host,
        },
      });
      const { spawnEnv } = await prepareCliTransport(ctx);
      const cmd = await invoke(spawnEnv.ALOOK_CLI!, ["--stdin"], directory, true, { env: spawnEnv, stdin: message });
      console.log(JSON.stringify({ stage: "cmd-utf8-stdin", ...cmd }));
      expect(cmd.stdout).toBe(message);
      expect(cmd.code).toBe(0);
      const script = [
        "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "@'", message, "'@ | & $env:ALOOK_CLI --stdin",
        "exit $LASTEXITCODE",
      ].join("\r\n");
      const powershell = await invoke("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], directory, false, { env: spawnEnv });
      console.log(JSON.stringify({ stage: "powershell-utf8-stdin", ...powershell }));
      expect(powershell.stdout).toBe(message);
      expect(powershell.code).toBe(0);
      const failed = await invoke(spawnEnv.ALOOK_CLI!, ["--fail"], directory, true, { env: spawnEnv });
      expect(failed.code).toBe(23);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});
