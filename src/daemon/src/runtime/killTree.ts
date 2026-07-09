/**
 * Process-tree termination with SIGKILL escalation.
 *
 * Agent CLIs are spawned detached on POSIX, so each becomes the leader of its
 * own process group (pgid = pid). Signalling the negative pid reaches the whole
 * group — the CLI plus any MCP servers / tool subprocesses it spawned — instead
 * of just the leader. A plain positive-pid SIGTERM leaves grandchildren orphaned.
 *
 * SIGTERM is a request; after a grace window we escalate to SIGKILL.
 */

const POLL_MS = 100;
const DEFAULT_GRACE_MS = 2000;
const isPosix = process.platform !== "win32";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (isPosix) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return;
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already dead
  }
}

/**
 * Terminate `pid` and its descendants: group SIGTERM, then group SIGKILL after
 * `graceMs`. Returns promptly when the target is already dead.
 */
export async function killProcessTree(
  pid: number,
  opts?: { graceMs?: number },
): Promise<void> {
  if (!pid || pid < 1) return;
  if (!isAlive(pid)) return;

  const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
  signalTree(pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (isAlive(pid)) {
    signalTree(pid, "SIGKILL");
  }
}
