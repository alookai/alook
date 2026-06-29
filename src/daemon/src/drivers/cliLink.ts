/**
 * Agent-facing CLI name decoupling — via the filesystem, not a forwarding script.
 *
 * The agent always invokes a stable `cliName` (e.g. `alook`). We make that name
 * resolve to the host's real CLI entrypoint by placing a link in a per-launch
 * `bin` dir that gets prepended to PATH:
 *
 *   - POSIX: a symlink `bin/<cliName> -> hostCliPath`. The kernel execs straight
 *     through, so NO wrapper script and NO shell escaping. REQUIRES hostCliPath
 *     to be a self-executable entrypoint (shebang + executable bit) — an npm
 *     `bin` symlink satisfies this. A host needing an interpreter prefix must
 *     ship its own self-exec wrapper as hostCliPath.
 *   - Windows: a symlink/hardlink named `.exe` pointing at a `.js` is NOT a valid
 *     executable (PE-format mismatch), so for interpreted CLIs we keep a `.cmd`
 *     shim. This is the ONLY place a generated wrapper survives, purely due to
 *     the platform.
 *
 * With no hostCliPath (the mock), neither is created — `cliName` stays
 * unresolved and invoking it fails with command-not-found (the mock never calls
 * back to a host).
 *
 * See `docs/design-exec-env.md`.
 */
import * as fs from "fs";
import * as path from "path";

/**
 * Create the per-launch `bin` dir and the link/shim for `cliName`. Returns the
 * bin dir to prepend to PATH. Idempotent: safe to call again on resume/restart.
 */
export function writeCliLink(
  stateDir: string,
  cliName: string,
  hostCliPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const binDir = path.join(stateDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  // Mock (no host CLI): create nothing — cliName intentionally won't resolve.
  if (!hostCliPath) return binDir;

  if (platform === "win32") {
    // .cmd shim — the only surviving wrapper, and only because a Windows link
    // named .exe pointing at a .js wouldn't be a valid executable.
    const cmdFile = path.join(binDir, `${cliName}.cmd`);
    const body = `@echo off\r\n"${hostCliPath}" %*\r\n`;
    fs.writeFileSync(cmdFile, body); // overwrite is fine (idempotent)
    return binDir;
  }

  // POSIX symlink — unlink-then-link so resume/restart doesn't throw EEXIST.
  const linkPath = path.join(binDir, cliName);
  try {
    fs.unlinkSync(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    fs.symlinkSync(hostCliPath, linkPath);
  } catch (err) {
    // A concurrent launch may have created it between unlink and symlink.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return binDir;
}
