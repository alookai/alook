import { appendFileSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { acquireLock, releaseLock } from "./filelock.js";
import { log } from "../../lib/logger.js";

function readJsonl(filePath: string): ContextTimelineEntry[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const entries: ContextTimelineEntry[] = [];
  for (const line of content.trimEnd().split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return entries;
}

export interface ContextTimelineEntry {
  task_id: string;
  context_key: string | null;
  session_id: string | null;
  pid: number | null;
  status: "running" | "completed" | "failed" | "killed" | "superseded" | "cancelled";
  successor_task_id?: string | null;
  supersede_reason?: string | null;
  datetime: string;
  type: string;
  prompt: string;
  agent_responses: string[];
  errmsg: string | null;
  provider: string | null;
  detailed_log: string | null;
}

function filenameForDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}.jsonl`;
}

function todayFilename(): string {
  return filenameForDate(new Date());
}

function recentFilenames(maxDays: number): string[] {
  const filenames: string[] = [];
  const now = new Date();
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    filenames.push(filenameForDate(d));
  }
  return filenames;
}

function localISOString(): string {
  const now = new Date();
  const tzOffset = -now.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffset);
  const hh = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const mm = String(absOffset % 60).padStart(2, "0");

  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");

  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${hh}:${mm}`;
}

function lockPathFor(timelineDir: string, filename: string): string {
  return join(timelineDir, `.${filename}.lock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function initEntry(
  timelineDir: string,
  entry: ContextTimelineEntry,
): void {
  const filename = todayFilename();
  const filePath = join(timelineDir, filename);
  const lockPath = lockPathFor(timelineDir, filename);

  try {
    const acquired = acquireLock(lockPath);
    if (!acquired) {
      log.debug(`Timeline initEntry: could not acquire lock for ${filename}`);
      return;
    }

    try {
      appendFileSync(filePath, JSON.stringify(entry) + "\n");
    } finally {
      releaseLock(lockPath);
    }
  } catch (err) {
    log.debug("Timeline initEntry failed", err);
  }
}

export async function initEntryAsync(
  timelineDir: string,
  entry: ContextTimelineEntry,
): Promise<void> {
  const filename = todayFilename();
  const filePath = join(timelineDir, filename);
  const lockPath = lockPathFor(timelineDir, filename);

  try {
    let acquired = acquireLock(lockPath);
    if (!acquired) {
      await sleep(200);
      acquired = acquireLock(lockPath);
    }
    if (!acquired) {
      log.debug(`Timeline initEntry: could not acquire lock for ${filename}`);
      return;
    }

    try {
      appendFileSync(filePath, JSON.stringify(entry) + "\n");
    } finally {
      releaseLock(lockPath);
    }
  } catch (err) {
    log.debug("Timeline initEntry failed", err);
  }
}

export function updateEntry(
  timelineDir: string,
  taskId: string,
  updater: (entry: ContextTimelineEntry) => void,
): void {
  for (const filename of recentFilenames(7)) {
    const filePath = join(timelineDir, filename);
    const lockPath = lockPathFor(timelineDir, filename);

    try {
      const acquired = acquireLock(lockPath);
      if (!acquired) {
        log.debug(`Timeline updateEntry: lock held for ${filename}, skipping`);
        continue;
      }

      try {
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          continue; // file doesn't exist for this day
        }

        const lines = content.trimEnd().split("\n");
        let found = false;

        const updated = lines.map((line) => {
          const entry: ContextTimelineEntry = JSON.parse(line);
          if (entry.task_id === taskId) {
            found = true;
            updater(entry);
          }
          return JSON.stringify(entry);
        });

        if (!found) continue;

        const tmpPath = join(timelineDir, `.${filename}.tmp`);
        writeFileSync(tmpPath, updated.join("\n") + "\n");
        renameSync(tmpPath, filePath);
        return; // found and updated — stop searching
      } finally {
        releaseLock(lockPath);
      }
    } catch (err) {
      log.debug(`Timeline updateEntry failed for ${filename}`, err);
    }
  }

  log.debug(`Timeline updateEntry: task_id ${taskId} not found in last 7 days`);
}

export function createTimelineEntry(
  taskId: string,
  prompt: string,
  type: string,
  sessionId?: string,
  pid?: number,
  provider?: string,
  contextKey?: string | null,
  detailedLog?: string | null,
): ContextTimelineEntry {
  return {
    task_id: taskId,
    context_key: contextKey ?? null,
    session_id: sessionId || null,
    pid: pid ?? null,
    status: "running",
    datetime: localISOString(),
    type,
    prompt,
    agent_responses: [],
    errmsg: null,
    provider: provider ?? null,
    detailed_log: detailedLog ?? null,
  };
}

const RESUME_MAX_AGE_MS = 72 * 60 * 60 * 1000; // 72 hours

export function findResumableSessionByContextKey(
  timelineDir: string,
  contextKey: string,
  provider: string,
): string | null {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RESUME_MAX_AGE_MS);
  const entries: ContextTimelineEntry[] = [];
  for (const filename of recentFilenames(7)) {
    entries.push(...readJsonl(join(timelineDir, filename)));
  }
  entries.sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime());
  for (const entry of entries) {
    if (
      entry.status !== "running" &&
      entry.context_key === contextKey &&
      entry.provider === provider &&
      entry.session_id &&
      new Date(entry.datetime) >= cutoff
    ) {
      return entry.session_id;
    }
  }
  return null;
}

export function findRunningPidByTaskId(
  timelineDir: string,
  taskId: string,
): number | null {
  for (const filename of recentFilenames(7)) {
    const entries = readJsonl(join(timelineDir, filename));
    for (const entry of entries) {
      if (entry.task_id === taskId && entry.status === "running" && entry.pid != null) {
        return entry.pid;
      }
    }
  }
  return null;
}

export function findRunningEntryByContextKey(
  timelineDir: string,
  contextKey: string,
  provider: string,
): ContextTimelineEntry | null {
  for (const filename of recentFilenames(7)) {
    const dayEntries = readJsonl(join(timelineDir, filename));
    for (let i = dayEntries.length - 1; i >= 0; i--) {
      const entry = dayEntries[i];
      if (
        entry.status === "running" &&
        entry.context_key === contextKey &&
        entry.provider === provider
      ) {
        return entry;
      }
    }
  }
  return null;
}

export { localISOString };

// Exported for testing
export {
  todayFilename as _todayFilename,
  localISOString as _localISOString,
  filenameForDate as _filenameForDate,
  recentFilenames as _recentFilenames,
};
