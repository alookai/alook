/**
 * Daemon version + client-info helpers.
 *
 * These are read from `@alook/daemon`'s own `package.json` across the source,
 * library bundle, and nested CLI bundle layouts. Everything on the wire that
 * identifies the daemon to a remote runtime CLI (for example Codex's
 * `initialize.clientInfo`)
 * flows through `getDaemonClientInfo()` so nobody hand-types the pre-alook
 * daemon-identity strings anymore.
 */
import { createRequire } from "module";

const requireFromHere = createRequire(import.meta.url);
const PACKAGE_JSON_CANDIDATES = ["../package.json", "../../package.json"] as const;

export function readDaemonVersion(): string {
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      const pkg = requireFromHere(candidate) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      continue;
    }
  }
  return "";
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
