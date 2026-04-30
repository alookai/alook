import { Command } from "commander";
import { spawn } from "child_process";
import { openSync, closeSync, mkdirSync } from "fs";
import { dirname } from "path";
import { startDaemon } from "../daemon/daemon.js";
import { daemonLogFilePath, pidFilePath } from "../daemon/config.js";
import {
  isProcessAlive,
  readDaemonPid,
  removePidFileIfMatches,
} from "../daemon/pidfile.js";
import { resolveLoginShellEnv } from "../lib/shell-env.js";
import { isWindows } from "../lib/platform.js";

const PID_POLL_INTERVAL_MS = 200;
const PID_POLL_TIMEOUT_MS = 2000;
const STOP_POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildChildArgs(profile?: string, serverUrl?: string): string[] {
  const entry = process.argv[1];
  const args = [entry];
  if (profile) args.push("--profile", profile);
  if (serverUrl) args.push("--server", serverUrl);
  args.push("daemon", "start", "--foreground");
  return args;
}

async function waitForPidFile(profile: string | undefined): Promise<number | null> {
  const deadline = Date.now() + PID_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pid = readDaemonPid(profile);
    if (pid != null && isProcessAlive(pid)) return pid;
    await sleep(PID_POLL_INTERVAL_MS);
  }
  return null;
}

async function startInBackground(
  profile?: string,
  serverUrl?: string,
): Promise<void> {
  const existing = readDaemonPid(profile);
  if (existing != null && isProcessAlive(existing)) {
    console.error(`Daemon already running (pid=${existing}).`);
    process.exit(1);
    return;
  }

  const logPath = daemonLogFilePath();
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(logPath, "a", 0o600);

  const child = spawn(process.execPath, buildChildArgs(profile, serverUrl), {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: resolveLoginShellEnv(),
  });
  child.unref();
  closeSync(logFd);

  const pid = await waitForPidFile(profile);
  if (pid != null) {
    console.log(`Daemon started (pid=${pid})`);
    console.log(`Logs: ${logPath}`);
    return;
  }
  console.error(
    `Daemon did not write a pidfile within ${PID_POLL_TIMEOUT_MS}ms — check logs: ${logPath}`,
  );
  process.exit(1);
}

function statusCommand(profile: string | undefined): void {
  const pid = readDaemonPid(profile);
  const profileSuffix = profile ? ` profile=${profile}` : "";
  if (pid == null) {
    console.log(`Daemon not running.${profileSuffix}`);
    return;
  }
  if (!isProcessAlive(pid)) {
    console.log(
      `Daemon not running (stale pidfile at ${pidFilePath(profile)}).${profileSuffix}`,
    );
    return;
  }
  console.log(`Daemon running (pid=${pid})${profileSuffix}`);
}

async function stopCommand(profile: string | undefined): Promise<void> {
  const pid = readDaemonPid(profile);
  if (pid == null) {
    console.log("Daemon not running.");
    return;
  }
  if (!isProcessAlive(pid)) {
    removePidFileIfMatches(pid, profile);
    console.log("Daemon not running.");
    return;
  }

  console.log(`Stopping daemon (pid=${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    console.error(`Failed to signal daemon: ${e}`);
    process.exit(1);
  }

  const shutdownMs =
    Number(process.env.ALOOK_SHUTDOWN_TIMEOUT_MS) || 5000;
  const deadline = Date.now() + shutdownMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      console.log("Daemon stopped.");
      return;
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }

  console.warn(
    `Daemon did not exit within ${shutdownMs}ms — force killing.`,
  );
  if (!isWindows) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  removePidFileIfMatches(pid, profile);
  console.log("Daemon stopped.");
}

export function daemonCommand(): Command {
  const cmd = new Command("daemon").description("Manage the Alook daemon");

  cmd
    .command("start")
    .description("Start the daemon")
    .option("--foreground", "Run in foreground")
    .option("--server <url>", "Server URL override")
    .action(async (opts, command) => {
      const parentOpts = command.parent?.parent?.opts() || {};
      const profile: string | undefined = parentOpts.profile;
      const serverUrl: string | undefined = opts.server || parentOpts.server;

      if (opts.foreground) {
        await startDaemon(profile, serverUrl);
        return;
      }

      await startInBackground(profile, serverUrl);
    });

  cmd
    .command("status")
    .description("Show daemon status")
    .action((_opts, command) => {
      const parentOpts = command.parent?.parent?.opts() || {};
      statusCommand(parentOpts.profile);
    });

  cmd
    .command("stop")
    .description("Stop the running daemon")
    .action(async (_opts, command) => {
      const parentOpts = command.parent?.parent?.opts() || {};
      await stopCommand(parentOpts.profile);
    });

  return cmd;
}
