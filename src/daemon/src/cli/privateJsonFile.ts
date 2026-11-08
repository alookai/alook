import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writePrivateJsonAtomic(filePath: string, value: object): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | null = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
    syncDirectory(dir);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {  }
    }
    try { fs.unlinkSync(tempPath); } catch {  }
  }
}
