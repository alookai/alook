/**
 * Agent process spawn + process-tree termination with SIGKILL escalation.
 *
 * These two live together on purpose: they're opposite ends of the SAME
 * contract. `spawnAgentProcess` is the ONLY way a driver may start an agent
 * CLI — it always spawns `detached` on POSIX, making the child the leader of
 * its own process group (pgid = pid). That's what lets `killProcessTree`
 * signal the negative pid to reach the whole group — the CLI plus any MCP
 * servers / tool subprocesses it spawns — instead of just the leader, which
 * would otherwise leave grandchildren orphaned.
 *
 * BackendAdapter files must NOT call `child_process.spawn` directly for the agent CLI
 * — always go through `spawnAgentProcess` here, so the detached contract
 * can't be silently skipped by a new (or edited) driver.
 *
 * On POSIX, SIGTERM is a request and we escalate the process group to SIGKILL
 * after a grace window. Windows has no equivalent process-group signal, so we
 * delegate recursive termination to `taskkill /T`, escalating to `/F` after the
 * same grace window. Awaiting taskkill is important: killing only the `.cmd`
 * shell pid can leave the actual runtime alive and holding its cwd open.
 */
import { spawn, type ChildProcess } from "child_process";

const POLL_MS = 100;
const FORCE_EXIT_WAIT_MS = 2_000;
/**
 * Standard grace before SIGKILL when the manager stops a running session.
 * Every session-level stop path (logical stop, forced stop,
 * the process-lane stop fallback) shares this so the "how long
 * before we kill it hard" answer is one number, not three drifting ones.
 *
 * MUST stay strictly below `daemonStart.ts`'s `STOP_GRACE_MS` (the window
 * `alook daemon stop` gives the DAEMON before SIGKILLing it). The daemon's
 * SIGTERM handler awaits `manager.stopAll()`, which awaits these per-session
 * kills — so if the two windows were equal, an agent CLI that ignores SIGTERM
 * would still be inside its own grace when the outer SIGKILL lands, killing
 * the daemon before it ever escalates to SIGKILL on the child. The child is
 * detached (its own process group), so it would survive as an orphan.
 */
export const SESSION_STOP_GRACE_MS = 2000;
const DEFAULT_GRACE_MS = SESSION_STOP_GRACE_MS;
const isPosix = process.platform !== "win32";

interface AgentSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Run through a shell — needed on Windows for `.cmd`/`.bat` shims. */
  shell?: boolean;
  /**
   * stdin disposition. Default `"pipe"` for persistent stdio transports. A
   * one-shot adapter that proves it never reads stdin may opt into `"ignore"`.
   * stdout/stderr stay piped regardless for protocol output and diagnostics.
   */
  stdin?: "pipe" | "ignore";
}

/**
 * The only sanctioned way to spawn an agent CLI child process. Always pipes
 * stdio and (on POSIX) spawns `detached` so the child becomes its own
 * process-group leader — required for `killProcessTree`'s group signal to
 * actually reach it (and its grandchildren) instead of silently no-oping.
 * See the module doc comment above for why this must be the single spawn
 * entry point rather than each driver calling `child_process.spawn` itself.
 */
export function spawnAgentProcess(command: string, args: string[], opts: AgentSpawnOptions): ChildProcess {
  return spawn(command, args, {
    cwd: opts.cwd,
    // stdout/stderr always piped (we read stream-json/JSON-RPC); stdin defaults
    // to pipe for persistent transports. See AgentSpawnOptions.stdin.
    stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    env: opts.env,
    shell: opts.shell ?? false,
    detached: isPosix,
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Best-effort group signal, ALWAYS followed by a direct pid signal —
 * regardless of whether the group signal succeeded, threw `ESRCH` (no such
 * process group — e.g. the child wasn't spawned detached), or threw anything
 * else. A group signal failure must never be mistaken for "the pid is dead":
 * that conflates two unrelated failure semantics and was the root cause of a
 * bug where stopped agents kept running forever (see
 * plans/fix-daemon-agent-process-kill.md). Signaling an already-dead pid is
 * safe — it just throws ESRCH too, caught and ignored below.
 */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (isPosix) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Most commonly ESRCH (no such process group — not detached, or
      // already gone), but any failure here falls through the same way:
      // never treat it as proof the pid itself is dead.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

/** Run Windows' forced process-tree terminator and await its tree walk. */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const settle = (result: "resolve" | "reject", error?: Error) => {
      if (settled) return;
      settled = true;
      if (result === "resolve") resolve();
      else reject(error);
    };
    killer.once("error", (error) => {
      settle("reject", new Error(`failed to launch Windows process-tree termination: ${error.message}`));
    });
    killer.once("close", (code, signal) => {
      if (code === 0) {
        settle("resolve");
        return;
      }
      settle(
        "reject",
        new Error(`Windows process-tree termination failed (exit=${String(code)}, signal=${String(signal)})`),
      );
    });
  });
}

async function killWindowsProcessTree(pid: number, graceMs: number): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  if (!isAlive(pid)) return;
  // A single /T /F call snapshots and terminates the complete tree while the
  // wrapper pid is still alive. Killing the wrapper first would orphan the
  // actual runtime and make a later tree walk unable to discover it.
  await taskkillTree(pid);
  await waitForProcessExit(pid, FORCE_EXIT_WAIT_MS);
  if (isAlive(pid)) throw new Error(`Windows process tree ${pid} remained alive after taskkill completed`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Terminate `pid` and its descendants: POSIX process-group signals or Windows
 * taskkill tree traversal, with force escalation after `graceMs`. Returns
 * promptly when the target is already dead.
 */
export async function killProcessTree(
  pid: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (!pid || pid < 1) return;
  if (!isAlive(pid)) return;

  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  if (!isPosix) {
    await killWindowsProcessTree(pid, graceMs);
    return;
  }
  signalTree(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (isAlive(pid)) {
    signalTree(pid, "SIGKILL");
    await waitForProcessExit(pid, FORCE_EXIT_WAIT_MS);
    if (isAlive(pid)) throw new Error(`POSIX process tree ${pid} remained alive after SIGKILL`);
  }
}
