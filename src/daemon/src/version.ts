/**
 * Daemon version + client-info helpers.
 *
 * These are read from `@alook/daemon`'s own `package.json` (the file loaded
 * via `createRequire` at `../package.json`, i.e. this workspace's package
 * manifest). Everything on the wire that identifies the daemon to a remote
 * runtime CLI (Kimi's `initialize.client`, Codex's `initialize.clientInfo`)
 * flows through `getDaemonClientInfo()` so nobody hand-types the pre-alook
 * daemon-identity strings anymore.
 */
import { createRequire } from "module";

const requireFromHere = createRequire(import.meta.url);

export function readDaemonVersion(): string {
  try {
    const pkg = requireFromHere("../package.json") as { version?: string };
    return pkg.version ?? "";
  } catch {
    return "";
  }
}

export interface DaemonClientInfo {
  name: string;
  version: string;
}

/**
 * Identity the daemon reports to a remote runtime CLI's `initialize` frame.
 * Read the version at call-time so bumping `package.json` doesn't require a
 * daemon restart to update in-flight identify frames (there aren't any right
 * now, but the freshness is essentially free).
 */
export function getDaemonClientInfo(): DaemonClientInfo {
  return { name: "alook-daemon", version: readDaemonVersion() };
}
