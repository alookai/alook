import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const MEMORY_COMMIT_MAX_BYTES = 10 * 1024;
export const MEMORY_COMMITS_FILE_MAX_BYTES = 1024 * 1024;
export const LOCAL_MEMORY_COMMIT_PATH = "/__alook/local/commit";

export interface MemoryCommit {
  no: number;
  time: string;
  log: string;
  reset: boolean;
}

export function validateMemoryCommit(value: unknown): { log: string; reset: boolean } {
  if (!value || typeof value !== "object") throw new Error("commit: log and reset are required");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "log" && key !== "reset")) throw new Error("commit: unknown field");
  if (typeof input.log !== "string" || !input.log.trim()) throw new Error("commit: a nonblank log is required (--file or --stdin)");
  if (Buffer.byteLength(input.log, "utf8") > MEMORY_COMMIT_MAX_BYTES) throw new Error("commit: log exceeds 10 KiB (10240 UTF-8 bytes)");
  if (typeof input.reset !== "boolean") throw new Error("commit: reset must be a boolean");
  return { log: input.log, reset: input.reset };
}

export function appendMemoryCommit(workdir: string, input: { log: string; reset: boolean }, now = new Date()): MemoryCommit {
  validateMemoryCommit(input);
  const file = path.join(workdir, ".commits.jsonl");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("commit: .commits.jsonl must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let fd: number | null = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("commit: .commits.jsonl must be a regular file");
    let no = 0;
    const size = Math.min(stat.size, MEMORY_COMMITS_FILE_MAX_BYTES);
    const tail = Buffer.alloc(size);
    if (stat.size) {
      const read = fs.readSync(fd, tail, 0, size, stat.size - size);
      if (read !== size || tail[size - 1] !== 10) throw new Error("commit: incomplete last record in .commits.jsonl");
      const start = tail.lastIndexOf(10, size - 2) + 1;
      if (start === 0 && stat.size > size) throw new Error("commit: invalid last record in .commits.jsonl");
      const previous = JSON.parse(tail.subarray(start, size - 1).toString("utf8")) as MemoryCommit;
      if (!Number.isSafeInteger(previous.no) || previous.no < 0 || previous.no >= Number.MAX_SAFE_INTEGER
        || typeof previous.time !== "string" || typeof previous.log !== "string" || typeof previous.reset !== "boolean") {
        throw new Error("commit: invalid last record in .commits.jsonl");
      }
      no = previous.no + 1;
    }
    const entry = { no, time: now.toISOString(), log: input.log, reset: input.reset };
    const line = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
    if (stat.size + line.length <= MEMORY_COMMITS_FILE_MAX_BYTES) {
      fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
    } else {
      const drop = size + line.length - MEMORY_COMMITS_FILE_MAX_BYTES;
      const start = tail.indexOf(10, drop - 1) + 1;
      const temp = path.join(workdir, `.commits-${randomUUID()}.tmp`);
      const tempFd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        try {
          fs.writeFileSync(tempFd, Buffer.concat([tail.subarray(start), line]));
          fs.fsyncSync(tempFd);
        } finally {
          fs.closeSync(tempFd);
        }
        const previousFd = fd;
        fd = null;
        fs.closeSync(previousFd);
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    return entry;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
