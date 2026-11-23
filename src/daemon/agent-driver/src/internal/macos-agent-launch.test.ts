import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree, spawnAgentProcess } from "./killTree.js";
import { macosAgentLauncher } from "./macos-agent-launch.js";

const guiSession = process.platform === "darwin"
  && spawnSync("/bin/launchctl", ["print", `gui/${process.getuid?.()}`], { stdio: "ignore" }).status === 0;

describe.runIf(guiSession)("macOS backend launch", () => {
  let directory: string;
  let originalEntrypoint: string;

  beforeAll(() => {
    directory = mkdtempSync("/private/tmp/alook-launch-test.");
    const launcher = join(directory, "launcher");
    execFileSync("/usr/bin/xcrun", [
      "clang", "-Wall", "-Wextra", "-Werror", "-DALOOK_AGENT_LAUNCHER_STANDALONE", "-framework", "CoreFoundation",
      fileURLToPath(new URL("../../../../desktop/src-tauri/src/macos_agent_launcher.c", import.meta.url)), "-o", launcher,
    ]);
    const entrypoint = join(directory, "cleanup.mjs");
    writeFileSync(entrypoint, `
      import { writeFileSync } from "node:fs";
      import { setTimeout } from "node:timers/promises";
      if (process.argv[2] !== "--alook-macos-agent-cleanup") process.exit(1);
      const pid = Number(process.argv[3]);
      process.kill(pid, "SIGTERM");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await setTimeout(10);
        try { process.kill(pid, 0); } catch {
          writeFileSync(new URL("./cleaned", import.meta.url), String(pid));
          process.exit(0);
        }
      }
      process.exit(1);
    `);
    originalEntrypoint = process.argv[1];
    process.argv[1] = entrypoint;
    vi.stubEnv(macosAgentLauncher, realpathSync(launcher));
  });

  afterAll(() => {
    if (originalEntrypoint) process.argv[1] = originalEntrypoint;
    vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("transfers original stdio, cwd and environment then waits for native shutdown", async () => {
    const program = [
      "process.stdin.once('data', input =>",
      "  console.log(JSON.stringify({ pid: process.pid, cwd: process.cwd(), input: String(input), env: process.env.TEST_MARKER })));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const worker = spawnAgentProcess(process.execPath, ["-e", program], {
      cwd: directory, env: { TEST_MARKER: "preserved\nvalue" }, macosIdentity: true,
    });
    let backendPid: number | undefined;
    try {
      const output = once(worker.stdout!, "data");
      worker.stdin!.write("from client");
      const [chunk] = await output;
      const report = JSON.parse(String(chunk));
      backendPid = report.pid;
      expect(report).toEqual({ pid: expect.any(Number), cwd: directory, input: "from client", env: "preserved\nvalue" });
      expect(backendPid).not.toBe(worker.pid);
      await killProcessTree(worker.pid!, { graceMs: 100 });
      expect(readFileSync(join(directory, "cleaned"), "utf8")).toBe(String(backendPid));
      backendPid = undefined;
    } finally {
      if (worker.pid) await killProcessTree(worker.pid);
      if (backendPid) {
        try { process.kill(backendPid, "SIGKILL"); } catch { /* Worker already exited. */ }
      }
    }
  });

  it("cancels a launch before it executes the backend program", async () => {
    const marker = join(directory, "ran");
    const worker = spawnAgentProcess(process.execPath, [
      "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker,
    ], { cwd: directory, macosIdentity: true });
    expect(worker.pid).toEqual(expect.any(Number));
    await killProcessTree(worker.pid!, { graceMs: 100 });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a stop when the supervisor exits without confirming cleanup", async () => {
    const launcher = join(directory, "failed-launcher");
    writeFileSync(launcher, "#!/bin/sh\nexit 125\n", { mode: 0o700 });
    const configuredLauncher = process.env[macosAgentLauncher];
    vi.stubEnv(macosAgentLauncher, launcher);
    try {
      const worker = spawnAgentProcess(process.execPath, ["-v"], { cwd: directory, macosIdentity: true });
      await expect(killProcessTree(worker.pid!)).rejects.toThrow("could not finish cleanup");
    } finally {
      vi.stubEnv(macosAgentLauncher, configuredLauncher);
    }
  });
});
