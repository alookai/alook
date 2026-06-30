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
import { appendFileSync, readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { acquireLock, releaseLock, lockPathFor } from "./filelock.js";
import type { ContextTimelineEntry } from "./types.js";
import type { Message } from "../server/contract.js";

/* ------------------------------------------------------------------ */
/* Date / filename helpers (injectable clock)                          */
/* ------------------------------------------------------------------ */

export function filenameForDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}.jsonl`;
}

/** Local-timezone ISO-8601 (with offset), e.g. 2026-06-25T17:11:05+08:00. */
export function localISOString(now: Date): string {
  const tzOffset = -now.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const abs = Math.abs(tzOffset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${hh}:${mm}`;
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
      entries.push(JSON.parse(line) as ContextTimelineEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return entries;
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
  const filename = filenameForDate(now);
  const filePath = join(timelineDir, filename);
  const lockPath = lockPathFor(timelineDir, filename);
  if (!acquireLock(lockPath)) return false;
  try {
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
    return true;
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
  const filename = filenameForDate(now);
  const filePath = join(timelineDir, filename);
  const lockPath = lockPathFor(timelineDir, filename);
  if (!acquireLock(lockPath)) return false;
  try {
    let lines: string[] = [];
    if (existsSync(filePath)) {
      lines = readFileSync(filePath, "utf-8").trimEnd().split("\n").filter(Boolean);
    }
    if (lines.length > 0) {
      const latest = JSON.parse(lines[lines.length - 1]) as ContextTimelineEntry;
      const mergeable =
        latest.session_id === entry.session_id &&
        latest.provider === entry.provider &&
        latest.agent_responses.length === 0;
      if (mergeable) {
        latest.messages = [...latest.messages, ...entry.messages];
        lines[lines.length - 1] = JSON.stringify(latest);
        const tmpPath = join(timelineDir, `.${filename}.tmp`);
        writeFileSync(tmpPath, lines.join("\n") + "\n");
        renameSync(tmpPath, filePath);
        return true;
      }
    }
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
    return true;
  } catch {
    return false;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Mutate the MOST-RECENT entry (the last appended row in the newest day file)
 * via `updater`, rewriting that file atomically under lock. This is how the
 * control plane (manager) targets "the agent's current turn" without threading a
 * task id across layers — the data plane appended that row on the inbox pull that
 * opened the turn, so it is the latest when responses/end arrive. Returns true if
 * a row was updated. Searches the newest day file with any rows first.
 */
export function updateLatestEntry(
  timelineDir: string,
  updater: (entry: ContextTimelineEntry) => void,
  opts: { maxDays?: number; now?: Date } = {},
): boolean {
  const now = opts.now ?? new Date();
  const maxDays = opts.maxDays ?? 7;
  for (const filename of recentFilenames(maxDays, now)) {
    const filePath = join(timelineDir, filename);
    // Nothing to update if this day has no file yet — skip BEFORE locking, so we
    // never try to mkdir a lock dir under a timelineDir that doesn't exist (the
    // common case: a runtime event arrives before the first inbox-pull opened any
    // entry). Avoids an ENOENT from the lock's non-recursive mkdir.
    if (!existsSync(filePath)) continue;
    const lockPath = lockPathFor(timelineDir, filename);
    if (!acquireLock(lockPath)) continue;
    try {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue; // no file for this day → look at an older day
      }
      const lines = content.trimEnd().split("\n").filter(Boolean);
      if (lines.length === 0) continue;
      const entries = lines.map((l) => JSON.parse(l) as ContextTimelineEntry);
      updater(entries[entries.length - 1]); // last appended = most recent
      const tmpPath = join(timelineDir, `.${filename}.tmp`);
      writeFileSync(tmpPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      renameSync(tmpPath, filePath);
      return true;
    } catch {
      /* try an older day file */
    } finally {
      releaseLock(lockPath);
    }
  }
  return false;
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

/* ------------------------------------------------------------------ */
/* Queries (pure over already-read rows)                               */
/* ------------------------------------------------------------------ */

/**
 * The agent's most recent session id — the resume target so its next launch
 * continues the prior runtime session. `rows` are in time order (readRecentEntries
 * preserves day-file order = append order = time order), so the resume target is
 * simply the LAST row carrying a session_id, optionally constrained to a provider
 * (don't resume a claude session into a codex launch). One session per agent and
 * each timeline lives in that agent's own workdir, so there's no thread keying.
 */
export function findResumableSession(rows: ContextTimelineEntry[], provider?: string): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i];
    if (!e.session_id) continue;
    if (provider && e.provider !== provider) continue;
    return e.session_id;
  }
  return null;
}
