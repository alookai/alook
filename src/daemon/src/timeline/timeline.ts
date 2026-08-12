/**
 * Context timeline — per-agent, per-day JSONL append-log.
 *
 * Layout: `<timelineDir>/YYYY-MM-DD.jsonl`, one `ContextTimelineEntry` per line.
 * `timelineDir` is `<agentWorkdir>/.context_timeline`. Writes are guarded by a
 * per-file lock (see `filelock.ts`) so concurrent runners can't corrupt a day
 * file. This is a pure daily log — it does NOT drive steering; it only records
 * turns and answers latest-session-id lookups for cross-restart resume.
 *
 * `now` is injectable everywhere a timestamp/clock is needed so callers/tests are
 * deterministic — this module never calls `Date.now()`/`new Date()` implicitly
 * except behind the default param.
 */
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { acquireLock, releaseLock, lockPathFor } from "./filelock.js";
import type { ContextTimelineEntry, SystemEntryType } from "./types.js";
import type { Message } from "../server/contract.js";
import { localISOString } from "../util/localTime.js";

export { localISOString };

export const TIMELINE_MAX_BYTES = 1_048_576;
export const TIMELINE_READ_CHUNK_BYTES = 65_536;
const DATE_FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

interface TimelineLine {
  text: string;
  bytes: number;
  entry: ContextTimelineEntry;
  barrier: boolean;
}

function isBarrier(entry: ContextTimelineEntry): boolean {
  return entry.system?.type === "reset_session" || entry.system?.type === "nap";
}

function canonicalTimelineEntry(value: unknown): ContextTimelineEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ContextTimelineEntry>;
  if (entry.system) {
    if (
      (entry.system.type !== "reset_session" && entry.system.type !== "nap") ||
      typeof entry.system.time !== "string"
    ) return null;
    return createSystemEntry(entry.system.type, entry.system.time);
  }
  if (entry.session_id !== null && typeof entry.session_id !== "string") return null;
  if (entry.provider !== null && typeof entry.provider !== "string") return null;
  if (!Array.isArray(entry.messages) || !Array.isArray(entry.agent_responses)) return null;
  if (!entry.agent_responses.every((response) => typeof response === "string")) return null;
  return {
    session_id: entry.session_id,
    messages: entry.messages,
    agent_responses: entry.agent_responses.slice(-5),
    provider: entry.provider,
  };
}

function timelineLine(entry: ContextTimelineEntry): TimelineLine | null {
  const boundedEntry = entry.system
    ? createSystemEntry(entry.system.type, entry.system.time)
    : { ...entry, agent_responses: entry.agent_responses.slice(-5) };
  const text = JSON.stringify(boundedEntry);
  const bytes = Buffer.byteLength(text, "utf8") + 1;
  if (bytes > TIMELINE_MAX_BYTES) return null;
  return { text, bytes, entry: boundedEntry, barrier: isBarrier(boundedEntry) };
}

function compactLines(input: readonly TimelineLine[]): TimelineLine[] {
  let head = 0;
  let bytes = input.reduce((total, line) => total + line.bytes, 0);
  let latestEvictedBarrier: TimelineLine | null = null;
  while (bytes > TIMELINE_MAX_BYTES && head < input.length) {
    const removed = input[head++]!;
    bytes -= removed.bytes;
    if (removed.barrier) latestEvictedBarrier = removed;
  }
  let suffix = input.slice(head);
  if (!suffix.some((line) => line.barrier) && latestEvictedBarrier) {
    let suffixHead = 0;
    while (latestEvictedBarrier.bytes + bytes > TIMELINE_MAX_BYTES && suffixHead < suffix.length) {
      bytes -= suffix[suffixHead++]!.bytes;
    }
    suffix = [latestEvictedBarrier, ...suffix.slice(suffixHead)];
  }
  return suffix;
}

function isRealDirectory(path: string): boolean {
  try {
    return fs.lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

type TimelineDirectoryState = "safe" | "missing" | "unsafe";

function timelineDirectoryState(timelineDir: string): TimelineDirectoryState {
  if (!isRealDirectory(dirname(timelineDir))) return "unsafe";
  try {
    return fs.lstatSync(timelineDir).isDirectory() ? "safe" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}

export function prepareTimelineDirectory(timelineDir: string): boolean {
  const state = timelineDirectoryState(timelineDir);
  if (state === "safe") return true;
  if (state === "unsafe") return false;
  try {
    fs.mkdirSync(timelineDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  return timelineDirectoryState(timelineDir) === "safe";
}

function scanTimelineFile(filePath: string): TimelineLine[] | null {
  let source: fs.Stats;
  try {
    source = fs.lstatSync(filePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  if (!source.isFile()) return null;

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;

    const chunk = Buffer.allocUnsafe(TIMELINE_READ_CHUNK_BYTES);
    const newest: TimelineLine[] = [];
    let retainedBytes = 0;
    let overflowed = false;
    let suffixHasBarrier = false;
    let latestEvictedBarrier: TimelineLine | null = null;
    let parts: Buffer[] = [];
    let partBytes = 0;
    let oversized = false;
    let stop = false;
    let discardIncompleteTail = false;

    if (stat.size > 0) {
      const last = Buffer.allocUnsafe(1);
      fs.readSync(fd, last, 0, 1, stat.size - 1);
      discardIncompleteTail = last[0] !== 10;
    }

    const resetPhysicalLine = (): void => {
      parts = [];
      partBytes = 0;
      oversized = false;
    };
    const addPart = (part: Buffer): void => {
      if (oversized) return;
      if (partBytes + part.length > TIMELINE_MAX_BYTES) {
        parts = [];
        partBytes = 0;
        oversized = true;
        return;
      }
      if (part.length > 0) parts.push(Buffer.from(part));
      partBytes += part.length;
    };
    const retain = (line: TimelineLine): void => {
      if (!overflowed && retainedBytes + line.bytes <= TIMELINE_MAX_BYTES) {
        newest.push(line);
        retainedBytes += line.bytes;
        if (line.barrier) suffixHasBarrier = true;
        return;
      }
      overflowed = true;
      if (suffixHasBarrier) {
        stop = true;
      } else if (line.barrier) {
        latestEvictedBarrier = line;
        stop = true;
      }
    };
    const finishPhysicalLine = (part: Buffer): void => {
      addPart(part);
      if (discardIncompleteTail) {
        discardIncompleteTail = false;
        resetPhysicalLine();
        return;
      }
      if (!oversized && partBytes > 0) {
        let physical = Buffer.concat([...parts].reverse(), partBytes);
        if (physical[physical.length - 1] === 13) physical = physical.subarray(0, -1);
        if (physical.length > 0) {
          try {
            const entry = canonicalTimelineEntry(JSON.parse(physical.toString("utf8")));
            const line = entry ? timelineLine(entry) : null;
            if (line) retain(line);
          } catch {
            /* malformed historical row */
          }
        }
      }
      resetPhysicalLine();
    };

    let position = stat.size;
    while (position > 0 && !stop) {
      const start = Math.max(0, position - chunk.length);
      const requested = position - start;
      let count = 0;
      while (count < requested) {
        const read = fs.readSync(fd, chunk, count, requested - count, start + count);
        if (read <= 0) break;
        count += read;
      }
      if (count !== requested) return null;
      let segmentEnd = count;
      for (let index = count - 1; index >= 0; index--) {
        if (chunk[index] !== 10) continue;
        finishPhysicalLine(chunk.subarray(index + 1, segmentEnd));
        segmentEnd = index;
        if (stop) break;
      }
      if (!stop && segmentEnd > 0) addPart(chunk.subarray(0, segmentEnd));
      position = start;
    }
    if (!stop && position === 0 && (parts.length > 0 || oversized) && !discardIncompleteTail) {
      finishPhysicalLine(Buffer.alloc(0));
    }

    const sentinel = latestEvictedBarrier as TimelineLine | null;
    if (sentinel && !suffixHasBarrier) {
      while (newest.length > 0 && sentinel.bytes + retainedBytes > TIMELINE_MAX_BYTES) {
        retainedBytes -= newest.pop()!.bytes;
      }
    }
    const chronological = newest.reverse();
    return sentinel && !suffixHasBarrier
      ? [sentinel, ...chronological]
      : chronological;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function atomicReplaceTimeline(filePath: string, lines: readonly TimelineLine[]): boolean {
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    const body = lines.map((line) => line.text).join("\n") + (lines.length > 0 ? "\n" : "");
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

function writeRequiredTimeline(
  filePath: string,
  input: readonly TimelineLine[],
  required: TimelineLine,
): boolean {
  const compacted = compactLines(input);
  if (!compacted.includes(required)) return false;
  return atomicReplaceTimeline(filePath, compacted);
}

/* ------------------------------------------------------------------ */
/* Date / filename helpers (injectable clock)                          */
/* ------------------------------------------------------------------ */

export function filenameForDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}.jsonl`;
}

/** Filenames for the last `maxDays` days, today first. */
export function recentFilenames(maxDays: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(filenameForDate(d));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

function readJsonl(filePath: string): ContextTimelineEntry[] {
  return scanTimelineFile(filePath)?.map((line) => line.entry) ?? [];
}

export interface ReadRecentOptions {
  /** How many days back to scan (default 7). */
  maxDays?: number;
  /** Injectable clock. */
  now?: Date;
}

/**
 * Read recent timeline rows across the last `maxDays` day files, in TIME ORDER
 * (oldest first). Entries carry no datetime field — ordering comes from the day
 * filename (date) and append order within each file. This is the input the pure
 * resume helper consumes; it does NOT read files itself.
 */
export function readRecentEntries(timelineDir: string, opts: ReadRecentOptions = {}): ContextTimelineEntry[] {
  if (timelineDirectoryState(timelineDir) !== "safe") return [];
  const now = opts.now ?? new Date();
  const maxDays = opts.maxDays ?? 7;
  // recentFilenames is today-first; reverse to oldest-first for ascending time.
  const filenames = recentFilenames(maxDays, now).reverse();
  const entries: ContextTimelineEntry[] = [];
  for (const filename of filenames) {
    entries.push(...readJsonl(join(timelineDir, filename)));
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Write (lock-guarded)                                                */
/* ------------------------------------------------------------------ */

/** Append a new entry to today's file. Best-effort: logs nothing, swallows lock miss. */
export function appendEntry(timelineDir: string, entry: ContextTimelineEntry, now: Date = new Date()): boolean {
  if (timelineDirectoryState(timelineDir) !== "safe") return false;
  const filename = filenameForDate(now);
  const filePath = join(timelineDir, filename);
  const lockPath = lockPathFor(timelineDir, filename);
  if (!acquireLock(lockPath)) return false;
  try {
    const existing = scanTimelineFile(filePath);
    const required = timelineLine(entry);
    if (!existing || !required) return false;
    return writeRequiredTimeline(filePath, [...existing, required], required);
  } catch {
    return false;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Open an entry for a new inbox pull, MERGING into the latest row instead of
 * appending a new one when that row is the "same still-unanswered turn":
 * identical `session_id` AND `provider` AND no `agent_responses` yet. That means
 * the agent pulled again before producing any output, so the new messages belong
 * to the same pending context — concat them rather than splitting the turn. This
 * also removes the response-misattribution race: there's never more than one
 * empty-response row that a late text event could land on. Otherwise (the latest
 * row already has responses, or differs in session/provider) append a fresh entry.
 *
 * Atomic under today's file lock: read latest → decide → merge-or-append in one
 * critical section. Best-effort (swallows lock miss / errors).
 */
export function appendOrMergeEntry(timelineDir: string, entry: ContextTimelineEntry, now: Date = new Date()): boolean {
  if (timelineDirectoryState(timelineDir) !== "safe") return false;
  const filename = filenameForDate(now);
  const filePath = join(timelineDir, filename);
  const lockPath = lockPathFor(timelineDir, filename);
  if (!acquireLock(lockPath)) return false;
  try {
    const existing = scanTimelineFile(filePath);
    if (!existing) return false;
    if (existing.length > 0) {
      const latest = existing[existing.length - 1]!.entry;
      const mergeable =
        !latest.system &&
        !entry.system &&
        latest.session_id === entry.session_id &&
        latest.provider === entry.provider &&
        latest.agent_responses.length === 0;
      if (mergeable) {
        const merged: ContextTimelineEntry = {
          ...latest,
          messages: [...latest.messages, ...entry.messages],
          agent_responses: [...latest.agent_responses],
        };
        const required = timelineLine(merged);
        if (!required) return false;
        return writeRequiredTimeline(filePath, [...existing.slice(0, -1), required], required);
      }
    }
    const required = timelineLine(entry);
    if (!required) return false;
    return writeRequiredTimeline(filePath, [...existing, required], required);
  } catch {
    return false;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Mutate the MOST-RECENT TURN entry via `updater`, rewriting that file
 * atomically under lock. This is how the control plane (manager) targets
 * "the agent's current turn" without threading a task id across layers —
 * the data plane appended that row on the inbox pull that opened the turn,
 * so it is the latest turn row when responses/end arrive.
 *
 * A system row (e.g. `reset_session` barrier) STOPS the walk and this
 * function returns false. Rationale: the barrier's semantics are
 * "everything before me belongs to a dead session"; a response landing
 * AFTER the barrier belongs to the NEW session and must NOT attach to a
 * pre-barrier turn row. When a barrier is the newest row (or a barrier
 * sits above every candidate turn row), returning false lets the caller
 * open a fresh turn row post-barrier instead.
 *
 * Returns false when the newest day file's newest non-empty row is a
 * system row, or there is no row at all.
 */
export function updateLatestEntry(
  timelineDir: string,
  updater: (entry: ContextTimelineEntry) => void,
  opts: { maxDays?: number; now?: Date } = {},
): boolean {
  return updateLatestEntryResult(timelineDir, updater, opts) === "updated";
}

export type UpdateLatestEntryResult = "updated" | "missing" | "rejected";

export function updateLatestEntryResult(
  timelineDir: string,
  updater: (entry: ContextTimelineEntry) => void,
  opts: { maxDays?: number; now?: Date } = {},
): UpdateLatestEntryResult {
  const directoryState = timelineDirectoryState(timelineDir);
  if (directoryState !== "safe") return directoryState === "missing" ? "missing" : "rejected";
  const now = opts.now ?? new Date();
  const maxDays = opts.maxDays ?? 7;
  for (const filename of recentFilenames(maxDays, now)) {
    const filePath = join(timelineDir, filename);
    // Nothing to update if this day has no file yet — skip BEFORE locking, so we
    // never try to mkdir a lock dir under a timelineDir that doesn't exist (the
    // common case: a runtime event arrives before the first inbox-pull opened any
    // entry). Avoids an ENOENT from the lock's non-recursive mkdir.
    let source: fs.Stats;
    try {
      source = fs.lstatSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return "rejected";
    }
    if (!source.isFile()) return "rejected";
    const lockPath = lockPathFor(timelineDir, filename);
    if (!acquireLock(lockPath)) return "rejected";
    try {
      const lines = scanTimelineFile(filePath);
      if (!lines) return "rejected";
      if (lines.length === 0) continue;
      // The newest row of the newest day file is authoritative: if it's a
      // system barrier, we must NOT walk past it into a pre-barrier turn.
      // Return false and let the caller open a fresh post-barrier turn row.
      const latest = lines[lines.length - 1]!.entry;
      if (latest.system) return "missing";
      const updated: ContextTimelineEntry = {
        ...latest,
        messages: [...latest.messages],
        agent_responses: [...latest.agent_responses],
      };
      try {
        updater(updated);
      } catch {
        return "rejected";
      }
      const required = timelineLine(updated);
      if (!required) return "rejected";
      return writeRequiredTimeline(filePath, [...lines.slice(0, -1), required], required)
        ? "updated"
        : "rejected";
    } catch {
      return "rejected";
    } finally {
      releaseLock(lockPath);
    }
  }
  return "missing";
}

export interface TimelineSweepOptions {
  yieldAfterFile?: (filePath: string) => Promise<void>;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function sweepTimelineHistory(
  workingDirectoryBase: string,
  opts: TimelineSweepOptions = {},
): Promise<void> {
  const yieldAfterFile = opts.yieldAfterFile ?? (() => yieldToEventLoop());
  if (!opts.yieldAfterFile) await yieldToEventLoop();
  if (!isRealDirectory(workingDirectoryBase)) return;

  let agentNames: string[];
  try {
    agentNames = fs.readdirSync(workingDirectoryBase).sort();
  } catch {
    return;
  }
  for (const agentName of agentNames) {
    const agentDir = join(workingDirectoryBase, agentName);
    if (!isRealDirectory(agentDir)) continue;
    const timelineDir = join(agentDir, ".context_timeline");
    if (!isRealDirectory(timelineDir)) continue;

    let filenames: string[];
    try {
      filenames = fs.readdirSync(timelineDir)
        .filter((name) => DATE_FILENAME_PATTERN.test(name))
        .sort();
    } catch {
      continue;
    }
    for (const filename of filenames) {
      const filePath = join(timelineDir, filename);
      let source: fs.Stats;
      try {
        source = fs.lstatSync(filePath);
      } catch {
        continue;
      }
      if (!source.isFile()) continue;

      try {
        const lockPath = lockPathFor(timelineDir, filename);
        if (acquireLock(lockPath)) {
          try {
            const lines = scanTimelineFile(filePath);
            if (lines) atomicReplaceTimeline(filePath, lines);
          } finally {
            releaseLock(lockPath);
          }
        }
      } catch {
        /* best-effort per file */
      }
      await yieldAfterFile(filePath);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export interface NewEntryFields {
  /** The messages the agent saw this turn (verbatim inbox-pull payload). */
  messages: Message[];
  sessionId?: string | null;
  provider?: string | null;
}

/** Build a fresh entry (the 4-field schema). */
export function createTimelineEntry(fields: NewEntryFields): ContextTimelineEntry {
  return {
    session_id: fields.sessionId ?? null,
    messages: fields.messages,
    agent_responses: [],
    provider: fields.provider ?? null,
  };
}

/**
 * Build a system entry. System rows are inlined in the JSONL alongside turns
 * so the resume walker and any agent-facing reader see them in place. The
 * first (and only) type today is `reset_session`.
 */
export function createSystemEntry(
  type: SystemEntryType,
  time: string,
): ContextTimelineEntry {
  return {
    session_id: null,
    messages: [],
    agent_responses: [],
    provider: null,
    system: { type, time },
  };
}

/* ------------------------------------------------------------------ */
/* Queries (pure over already-read rows)                               */
/* ------------------------------------------------------------------ */

/**
 * The agent's most recent session id — the resume target so its next launch
 * continues the prior runtime session. `rows` are in time order
 * (`readRecentEntries` preserves day-file order = append order = time order),
 * so the resume target is simply the LAST row carrying a session_id,
 * optionally constrained to a provider (don't resume a claude session into
 * a codex launch). One session per agent and each timeline lives in that
 * agent's own workdir, so there's no thread keying.
 *
 * A `system: { type: "reset_session" }` row is a barrier: the walker returns
 * null the moment it hits one going newest→oldest. Every turn at or before
 * the reset becomes invisible to resume without editing those rows. Since
 * kill happens BEFORE the barrier is written (see
 * `AgentProcessManager.resetSession`), no `forgot_session_id` fallback is
 * needed — no turn row can land after the barrier from the old session.
 */
export function findResumableSession(rows: ContextTimelineEntry[], provider?: string): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i];
    // Both reset_session (owner) and nap (agent self-reset) are resume
    // barriers — a fresh session was deliberately started at this point.
    if (e.system?.type === "reset_session" || e.system?.type === "nap") return null;
    if (!e.session_id) continue;
    if (provider && e.provider !== provider) continue;
    return e.session_id;
  }
  return null;
}
