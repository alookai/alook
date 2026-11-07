import { createRequire } from "module";
import { existsSync, readdirSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import * as path from "path";
import { resolveCommandOnPath, type ProbeDeps } from "../../internal/probe.js";

const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

function isPiSdkPackageJson(pkgJsonPath: string): boolean {
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { name?: string };
    return pkg.name === PI_SDK_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function resolvePiSdkPackageDir(deps: ProbeDeps = {}): string | undefined {
  const binPath = resolveCommandOnPath("pi", deps);
  if (!binPath) return undefined;

  try {
    let dir = path.dirname(realpathSync(binPath));
    const MAX_DEPTH = 8;
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (isPiSdkPackageJson(path.join(dir, "package.json"))) return dir;

      const siblingDir = path.join(dir, "node_modules", PI_SDK_PACKAGE_NAME);
      if (isPiSdkPackageJson(path.join(siblingDir, "package.json"))) return siblingDir;

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
  }
  return undefined;
}

export function findPiSessionFile(sessionDir: string, sessionId: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  const match = entries.find((entry) => entry.endsWith(suffix));
  return match ? path.join(sessionDir, match) : null;
}

/**
 * Resolve the Pi SDK's session directory for `cwd`.
 *
 * Prefers the SDK's own `getDefaultSessionDir`. That function is NOT on the
 * vendor barrel (it enumerates re-exports by name and omits this one), so
 * calling it unconditionally throws `sdk.getDefaultSessionDir is not a
 * function` and takes down every Pi resume — `withSessionDirHelper` in
 * `sessionDeps.ts` grafts it on from the deep `core/session-manager.js` module,
 * which is why it's usually present here despite the barrel gap.
 *
 * The fallback reproduces the SDK's rule (`core/session-manager.js`):
 * `<agentDir>/sessions/--<cwd with the leading separator stripped and
 * remaining separators/colons turned into dashes>--`, rooted at the exported
 * `getAgentDir()` (or `~/.pi/agent`). `getAgentDir` is the very function
 * `session-manager.js` itself imports as `getDefaultAgentDir`, so the two
 * paths agree today. This copy is the layer that can rot if the vendor
 * changes its encoding — see the drift note in the plan.
 *
 * Unlike the SDK helper this does not create the directory. That's fine:
 * `SessionManager` mkdirs on its first write, and `findPiSessionFile` treats
 * a missing dir as "no match" rather than an error.
 */
export function resolvePiSessionDir(
  sdk: { getDefaultSessionDir?: (cwd: string) => string; getAgentDir?: () => string },
  cwd: string,
): string {
  if (typeof sdk.getDefaultSessionDir === "function") return sdk.getDefaultSessionDir(cwd);
  const agentDir = typeof sdk.getAgentDir === "function"
    ? sdk.getAgentDir()
    : path.join(homedir(), ".pi", "agent");
  const encoded = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", encoded);
}

export function resolvePiSdkVersionFromPath(deps: ProbeDeps = {}): string | undefined {
  const dir = resolvePiSdkPackageDir(deps);
  if (!dir) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Read the installed Pi SDK's package version. Optional — the SDK isn't a
 * hard dep of the daemon, so we return undefined when it isn't installed on
 * the host, and the runtime chip renders without a version.
 *
 * Two detection paths, tried in order:
 *   1. `require()` resolution relative to this file — succeeds when Pi is a
 *      real dependency somewhere up the daemon's own `node_modules` tree
 *      (e.g. a future packaged build that bundles it).
 *   2. `resolvePiSdkVersionFromPath()` — succeeds when `pi` is installed
 *      globally and only reachable via `PATH`, which is how most users
 *      actually install it.
 */
export function readPiSdkVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("@earendil-works/pi-coding-agent/package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {

  }
  return resolvePiSdkVersionFromPath();
}

