import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeLaunchContext, fakePrepared } from "../testing/adapter-fixture.js";
import { prepareCliTransport } from "./cliTransport.js";
import { writeCliLink } from "./cliLink.js";
import { isAlive, killProcessTree, spawnAgentProcess } from "./killTree.js";

async function invoke(command: string, args: string[], cwd: string, shell: boolean) {
  const child = spawnAgentProcess(command, args, { cwd, env: process.env, shell });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const closed = once(child, "close");
  const timeout = setTimeout(() => { void killProcessTree(child.pid!).catch(() => {}); }, 5_000);
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
      expect((await invoke(process.execPath, [host, "--help"], directory, false)).stdout).toBe(expected);
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
      const injected = await invoke(spawnEnv.ALOOK_CLI!, ["--help"], directory, true);
      console.log(JSON.stringify({ stage: "injected-cli", ...injected }));
      expect.soft(injected.stdout).toBe(expected);
      expect.soft(injected.code).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 20_000);
});
