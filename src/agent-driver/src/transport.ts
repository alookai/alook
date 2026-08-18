import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const PROCESS_POLL_MS = 100;
const isPosix = process.platform !== "win32";

/** Shared grace window before a stopped agent process is escalated to SIGKILL. */
export const AGENT_DRIVER_STOP_GRACE_MS = 2_000;

export interface AgentDriverProcessSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Run through a shell, for example for Windows `.cmd` and `.bat` shims. */
  shell?: boolean;
  /** Defaults to `"pipe"`; use `"ignore"` for CLIs that wait on an open stdin. */
  stdin?: "pipe" | "ignore";
}

/**
 * Spawn an agent CLI with piped output and, on POSIX, its own process group.
 * The process-group boundary lets termination reach subprocesses created by
 * the CLI instead of only the group leader.
 */
export function spawnAgentDriverProcess(
  command: string,
  args: string[],
  opts: AgentDriverProcessSpawnOptions,
): ChildProcess {
  return spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: opts.shell ?? false,
    stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    detached: isPosix,
  });
}

export function isAgentDriverProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAgentDriverProcessGroupAlive(pid: number): boolean {
  if (!isPosix) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAgentDriverProcessTreeAlive(pid: number): boolean {
  return isAgentDriverProcessGroupAlive(pid) || isAgentDriverProcessAlive(pid);
}

function normalizeAgentDriverStopGraceMs(graceMs: number | undefined): number {
  return typeof graceMs === "number" && Number.isFinite(graceMs) && graceMs >= 0
    ? graceMs
    : AGENT_DRIVER_STOP_GRACE_MS;
}

function signalAgentDriverProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (isPosix) {
    try {
      process.kill(-pid, signal);
    } catch {
      // A non-detached process has no group keyed by its pid. Always fall
      // through to the direct-pid signal instead of treating ESRCH as dead.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // The process may already have exited after the group signal.
  }
}

/** Terminate an agent process tree with SIGTERM, then SIGKILL after the grace window. */
export async function terminateAgentDriverProcessTree(
  pid: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (!Number.isInteger(pid) || pid < 1 || !isAgentDriverProcessTreeAlive(pid)) return;

  const graceMs = normalizeAgentDriverStopGraceMs(opts?.graceMs);
  signalAgentDriverProcessTree(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAgentDriverProcessTreeAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
  }

  if (isAgentDriverProcessTreeAlive(pid)) {
    signalAgentDriverProcessTree(pid, "SIGKILL");
  }
}

/**
 * Frames arbitrary stdout chunks into complete, non-empty lines in arrival
 * order. A StringDecoder prevents a split UTF-8 code point from being
 * corrupted when Buffer chunks end mid-character.
 */
export class AgentDriverLineFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";

  push(chunk: Uint8Array): string[] {
    const text = this.decoder.write(Buffer.from(chunk));
    const lines = `${this.buffered}${text}`.split("\n");
    this.buffered = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}

/** Parse one JSON line, returning null for malformed or empty input. */
export function tryParseAgentDriverJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Serialize a JSON-RPC 2.0 request envelope without a trailing newline. */
export function serializeAgentDriverJsonRpcRequest(
  method: string,
  params: unknown,
  id?: string | number,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? randomUUID(), method, params });
}
