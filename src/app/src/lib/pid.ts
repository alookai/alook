import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { PID_FILE } from "./constants.js";

interface PidRecord {
  web?: number;
  emailWorker?: number;
  wsDo?: number;
}

export function readPids(): PidRecord {
  if (!existsSync(PID_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function writePids(pids: PidRecord): void {
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2), { mode: 0o600 });
}

export function clearPids(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
