import { tmpdir } from "os";
import { join, sep } from "path";

export const isWindows = process.platform === "win32";

export function tempDir(subdir: string): string {
  return join(tmpdir(), subdir);
}

export function isPathContained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
