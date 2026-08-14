import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DAEMON_BASE_DIR, WEB_URL, WS_URL } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MACHINE_ID = /^cm_[A-Za-z0-9_-]{8,64}$/;

export interface DaemonPorts {
  web: number;
  wsDo: number;
}

export interface DaemonProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function daemonEntry(): string {
  return join(__dirname, "daemon", "index.js");
}

function errorEnvelope(output: string): string | null {
  try {
    const parsed = JSON.parse(output.trim()) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

export function runEmbeddedDaemon(args: string[], showOutput = true): DaemonProcessResult {
  const result = spawnSync("node", [daemonEntry(), "daemon", ...args, "--base-dir", DAEMON_BASE_DIR], {
    encoding: "utf8",
    env: process.env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const daemonError = errorEnvelope(stdout);
  const ok = !result.error && result.status === 0 && daemonError === null;
  if (showOutput) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  return { ok, stdout, stderr };
}

export function listSavedDaemonIds(): string[] {
  const dir = join(DAEMON_BASE_DIR, "daemons");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".credential.json"))
    .map((name) => name.slice(0, -".credential.json".length))
    .filter((id) => MACHINE_ID.test(id))
    .sort();
}

export function listRunningDaemonIds(): string[] {
  const result = runEmbeddedDaemon(["list", "--json"], false);
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as {
      success?: { daemons?: Array<{ id?: unknown; alive?: unknown }> };
    };
    return (parsed.success?.daemons ?? [])
      .filter((daemon) => daemon.alive === true && typeof daemon.id === "string" && MACHINE_ID.test(daemon.id))
      .map((daemon) => daemon.id as string);
  } catch {
    return [];
  }
}

export function pairAndStartDaemon(machineKey: string, ports: DaemonPorts): boolean {
  return runEmbeddedDaemon([
    "start",
    "--machine-key", machineKey,
    "--server-url", WEB_URL(ports.web),
    "--ws-url", WS_URL(ports.wsDo),
  ]).ok;
}

export function startSavedDaemons(): { started: string[]; failed: string[] } {
  const running = new Set(listRunningDaemonIds());
  const started: string[] = [];
  const failed: string[] = [];
  for (const id of listSavedDaemonIds()) {
    if (running.has(id)) continue;
    if (runEmbeddedDaemon(["start", "--id", id]).ok) started.push(id);
    else failed.push(id);
  }
  return { started, failed };
}

export function stopSavedDaemons(): { stopped: string[]; failed: string[] } {
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const id of listRunningDaemonIds()) {
    if (runEmbeddedDaemon(["stop", id]).ok) stopped.push(id);
    else failed.push(id);
  }
  return { stopped, failed };
}
