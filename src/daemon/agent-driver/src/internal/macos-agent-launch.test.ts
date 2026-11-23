import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree, spawnAgentProcess } from "./killTree.js";
import { macosAgentLauncher, macosAgentSpawnSpec } from "./macos-agent-launch.js";

const source = fileURLToPath(new URL("../../../../desktop/src-tauri/src/macos_agent_launcher.c", import.meta.url));

describe.runIf(process.platform === "darwin")("macOS backend launch", () => {
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync("/private/tmp/alook-launch-test.");
    const launcher = join(directory, "launcher");
    execFileSync("/usr/bin/xcrun", [
      "clang", "-Wall", "-Wextra", "-Werror", "-DALOOK_AGENT_LAUNCHER_STANDALONE",
      source, "-o", launcher,
    ]);
    vi.stubEnv(macosAgentLauncher, realpathSync(launcher));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the owned PID and process group with the original stdio, cwd and environment", async () => {
    const program = [
      "process.stdin.once('data', input => console.log(JSON.stringify({",
      "  pid: process.pid, parent: process.ppid, cwd: process.cwd(), input: String(input),",
      "  env: process.env.TEST_MARKER, launcher: process.env.ALOOK_MACOS_AGENT_LAUNCHER,",
      "})));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const worker = spawnAgentProcess(process.execPath, ["-e", program], {
      cwd: directory,
      env: { TEST_MARKER: "preserved\nvalue", [macosAgentLauncher]: "host-only" },
      macosIdentity: true,
    });
    const closed = once(worker, "close");
    try {
      const output = once(worker.stdout!, "data");
      worker.stdin!.write("from client");
      const [chunk] = await output;
      expect(JSON.parse(String(chunk))).toEqual({
        pid: worker.pid, parent: process.pid, cwd: directory, input: "from client", env: "preserved\nvalue",
      });
      const group = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(worker.pid)], { encoding: "utf8" });
      expect(Number(group.trim())).toBe(worker.pid);
    } finally {
      if (worker.pid) await killProcessTree(worker.pid, { graceMs: 100 });
    }
    await expect(closed).resolves.toEqual([null, "SIGTERM"]);
  });

  it("preserves the backend exit status", async () => {
    const worker = spawnAgentProcess(process.execPath, ["-e", "process.exit(37)"], { cwd: directory, macosIdentity: true });
    await expect(once(worker, "close")).resolves.toEqual([37, null]);
  });

  it("keeps normal launch available when macOS reports independent identity is unsupported", async () => {
    const unsupported = join(directory, "unsupported.c");
    const launcher = join(directory, "unsupported-launcher");
    writeFileSync(unsupported, `
      #include <errno.h>
      #include <signal.h>
      #include <spawn.h>
      __attribute__((constructor)) static void start_with_ignored_sigpipe(void) {
        signal(SIGPIPE, SIG_IGN);
      }
      static int unsupported(posix_spawnattr_t *attributes, int enabled) {
        (void)attributes;
        (void)enabled;
        return ENOTSUP;
      }
      void *alook_test_dlsym(void *handle, const char *name) {
        (void)handle;
        (void)name;
        return (void *)unsupported;
      }
    `);
    execFileSync("/usr/bin/xcrun", [
      "clang", "-Wall", "-Wextra", "-Werror", "-DALOOK_AGENT_LAUNCHER_STANDALONE",
      "-Ddlsym=alook_test_dlsym", source, unsupported, "-o", launcher,
    ]);
    const normalLauncher = process.env[macosAgentLauncher];
    vi.stubEnv(macosAgentLauncher, launcher);
    try {
      const worker = spawnAgentProcess(process.execPath, ["-e", "process.exit(37)"], { cwd: directory, macosIdentity: true });
      let diagnostics = "";
      worker.stderr!.on("data", (chunk) => { diagnostics += String(chunk); });
      await expect(once(worker, "close")).resolves.toEqual([37, null]);
      expect(diagnostics).toContain("Independent macOS agent identity is unavailable");

      const brokenPipe = spawnAgentProcess("/usr/bin/yes", [], { cwd: directory, macosIdentity: true });
      const closed = once(brokenPipe, "close");
      brokenPipe.stdout!.destroy();
      await expect(closed).resolves.toEqual([null, "SIGPIPE"]);
    } finally {
      vi.stubEnv(macosAgentLauncher, normalLauncher);
    }
  });

  it("keeps shell scripts on their normal launch path", async () => {
    const script = join(directory, "script");
    writeFileSync(script, "#!/bin/sh\nexit 21\n", { mode: 0o700 });
    expect(macosAgentSpawnSpec(script, [], { cwd: directory })).toBeUndefined();
    const worker = spawnAgentProcess(script, [], { cwd: directory, macosIdentity: true });
    await expect(once(worker, "close")).resolves.toEqual([21, null]);
  });
});
