import { execSync } from "child_process";

export function isCommandAvailable(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectRuntimes(): { type: string; version: string }[] {
  const found: { type: string; version: string }[] = [];
  for (const type of ["claude", "codex", "opencode"]) {
    if (isCommandAvailable(type)) {
      let version = "";
      try {
        version = execSync(`${type} --version`, { encoding: "utf-8" }).trim();
      } catch {
        // version detection optional
      }
      found.push({ type, version });
    }
  }
  return found;
}
