import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock logger to prevent noise
vi.mock("../../../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { TASK_TYPES } from "@alook/shared";
import {
  initEntry,
  updateEntry,
  createTimelineEntry,
  findResumableSessionByContextKey,
  findRunningPidByTaskId,
  findRunningEntryByContextKey,
  _todayFilename,
  _localISOString,
  _filenameForDate,
  _recentFilenames,
  type ContextTimelineEntry,
} from "../timeline.js";

describe("timeline", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `timeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readEntries(): ContextTimelineEntry[] {
    const filename = _todayFilename();
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, "utf-8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("initEntry creates file if it doesn't exist and appends valid JSON line", () => {
    const entry = createTimelineEntry("t_abc", "do something", TASK_TYPES.USER_DM_MESSAGE);
    initEntry(dir, entry);

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].task_id).toBe("t_abc");
    expect(entries[0].session_id).toBeNull();
    expect(entries[0].pid).toBeNull();
    expect(entries[0].status).toBe("running");
    expect(entries[0].prompt).toBe("do something");
    expect(entries[0].type).toBe("user_dm_message");
    expect(entries[0].agent_responses).toEqual([]);
    expect(entries[0].errmsg).toBeNull();
  });

  it("createTimelineEntry stores sessionId and pid when provided", () => {
    const entry = createTimelineEntry("t_xyz", "test", TASK_TYPES.USER_DM_MESSAGE, "sess_1", 99999);
    initEntry(dir, entry);

    const entries = readEntries();
    expect(entries[0].session_id).toBe("sess_1");
    expect(entries[0].pid).toBe(99999);
  });

  it("updateEntry finds entry by task_id and updates steps", () => {
    const entry = createTimelineEntry("t_abc", "do something", TASK_TYPES.USER_DM_MESSAGE);
    initEntry(dir, entry);

    updateEntry(dir, "t_abc", (e) => {
      e.agent_responses.push("Step 1: Looking at the code...");
    });

    const entries = readEntries();
    expect(entries[0].agent_responses).toEqual(["Step 1: Looking at the code..."]);
  });

  it("updateEntry sets completion fields correctly", () => {
    const entry = createTimelineEntry("t_abc", "do something", TASK_TYPES.USER_DM_MESSAGE);
    initEntry(dir, entry);

    updateEntry(dir, "t_abc", (e) => {
      e.session_id = "sess_123";
      e.pid = null;
      e.status = "completed";
    });

    const entries = readEntries();
    expect(entries[0].session_id).toBe("sess_123");
    expect(entries[0].pid).toBeNull();
    expect(entries[0].status).toBe("completed");
    expect(entries[0].errmsg).toBeNull();
  });

  it("updateEntry sets failure fields correctly", () => {
    const entry = createTimelineEntry("t_fail", "will fail", TASK_TYPES.USER_DM_MESSAGE);
    initEntry(dir, entry);

    updateEntry(dir, "t_fail", (e) => {
      e.pid = null;
      e.status = "failed";
      e.errmsg = "something went wrong";
    });

    const entries = readEntries();
    expect(entries[0].pid).toBeNull();
    expect(entries[0].status).toBe("failed");
    expect(entries[0].errmsg).toBe("something went wrong");
  });

  it("multiple entries for different task_ids coexist in same file", () => {
    initEntry(dir, createTimelineEntry("t_1", "first task", TASK_TYPES.USER_DM_MESSAGE));
    initEntry(dir, createTimelineEntry("t_2", "second task", TASK_TYPES.USER_DM_MESSAGE));
    initEntry(dir, createTimelineEntry("t_3", "third task", TASK_TYPES.USER_DM_MESSAGE));

    const entries = readEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.task_id)).toEqual(["t_1", "t_2", "t_3"]);
  });

  it("updateEntry only modifies the matching task_id", () => {
    initEntry(dir, createTimelineEntry("t_1", "first task", TASK_TYPES.USER_DM_MESSAGE));
    initEntry(dir, createTimelineEntry("t_2", "second task", TASK_TYPES.USER_DM_MESSAGE));

    updateEntry(dir, "t_2", (e) => {
      e.agent_responses.push("Working on second task");
    });

    const entries = readEntries();
    expect(entries[0].agent_responses).toEqual([]);
    expect(entries[1].agent_responses).toEqual(["Working on second task"]);
  });

  it("timeline operations are best-effort — errors don't propagate", () => {
    // updateEntry on a non-existent directory should not throw
    expect(() => updateEntry("/nonexistent/path", "t_1", (e) => { e.agent_responses.push("x"); })).not.toThrow();
  });

  it("updateEntry is a no-op when task_id not found", () => {
    initEntry(dir, createTimelineEntry("t_1", "task", TASK_TYPES.USER_DM_MESSAGE));

    updateEntry(dir, "t_nonexistent", (e) => {
      e.agent_responses.push("should not happen");
    });

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].agent_responses).toEqual([]);
  });

  it("datetime is local timezone with UTC offset", () => {
    const dt = _localISOString();
    // Should match pattern like 2026-04-13T10:30:00+05:00 or 2026-04-13T10:30:00-05:00
    expect(dt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("todayFilename returns YYYY-MM-DD.jsonl format", () => {
    const filename = _todayFilename();
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  it("recentFilenames returns today first and correct count", () => {
    const filenames = _recentFilenames(3);
    expect(filenames).toHaveLength(3);
    expect(filenames[0]).toBe(_todayFilename());
    // Each should be a valid YYYY-MM-DD.jsonl
    for (const f of filenames) {
      expect(f).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    }
    // All distinct
    expect(new Set(filenames).size).toBe(3);
  });

  it("filenameForDate formats correctly", () => {
    const d = new Date(2026, 0, 5); // Jan 5, 2026
    expect(_filenameForDate(d)).toBe("2026-01-05.jsonl");
  });

  it("updateEntry finds entry in a past day's file", () => {
    // Write entry to yesterday's file manually
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const filename = _filenameForDate(yesterday);
    const entry = createTimelineEntry("t_old", "old task", TASK_TYPES.USER_DM_MESSAGE);
    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(entry) + "\n");

    // updateEntry should find it even though it's not in today's file
    updateEntry(dir, "t_old", (e) => {
      e.agent_responses.push("Updated across midnight");
    });

    const content = readFileSync(filePath, "utf-8");
    const updated: ContextTimelineEntry = JSON.parse(content.trimEnd());
    expect(updated.agent_responses).toEqual(["Updated across midnight"]);
  });

  it("updateEntry stops at first match and does not modify older files", () => {
    // Write same task_id in two different day files
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const todayFile = join(dir, _todayFilename());
    const yesterdayFile = join(dir, _filenameForDate(yesterday));

    const entryToday = createTimelineEntry("t_dup", "today version", TASK_TYPES.USER_DM_MESSAGE);
    const entryYesterday = createTimelineEntry("t_dup", "yesterday version", TASK_TYPES.USER_DM_MESSAGE);
    writeFileSync(todayFile, JSON.stringify(entryToday) + "\n");
    writeFileSync(yesterdayFile, JSON.stringify(entryYesterday) + "\n");

    updateEntry(dir, "t_dup", (e) => {
      e.status = "completed";
    });

    // Today's file should be updated
    const todayParsed: ContextTimelineEntry = JSON.parse(readFileSync(todayFile, "utf-8").trimEnd());
    expect(todayParsed.status).toBe("completed");

    // Yesterday's should be untouched
    const yesterdayParsed: ContextTimelineEntry = JSON.parse(readFileSync(yesterdayFile, "utf-8").trimEnd());
    expect(yesterdayParsed.status).toBe("running");
  });

  it("updateEntry is a no-op when task_id not found in any day", () => {
    // Write entries for today and yesterday with different task_ids
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    writeFileSync(join(dir, _todayFilename()), JSON.stringify(createTimelineEntry("t_a", "a", TASK_TYPES.USER_DM_MESSAGE)) + "\n");
    writeFileSync(join(dir, _filenameForDate(yesterday)), JSON.stringify(createTimelineEntry("t_b", "b", TASK_TYPES.USER_DM_MESSAGE)) + "\n");

    // Should not throw, just silently no-op
    updateEntry(dir, "t_nonexistent", (e) => {
      e.agent_responses.push("nope");
    });

    // Verify nothing changed
    const todayEntries = JSON.parse(readFileSync(join(dir, _todayFilename()), "utf-8").trimEnd());
    expect(todayEntries.agent_responses).toEqual([]);
  });

  describe("createTimelineEntry provider and context_key", () => {
    it("includes provider field when provided", () => {
      const entry = createTimelineEntry("t_p1", "test", "user_dm_message", "sess_1", 1234, "claude");
      expect(entry.provider).toBe("claude");
    });

    it("sets provider to null when not provided (backward compat)", () => {
      const entry = createTimelineEntry("t_p2", "test", "user_dm_message", "sess_1", 1234);
      expect(entry.provider).toBeNull();
    });

    it("includes context_key when provided", () => {
      const entry = createTimelineEntry("t_c1", "test", "user_dm_message", "sess_1", 1234, "claude", "conv_abc");
      expect(entry.context_key).toBe("conv_abc");
    });

    it("sets context_key to null when not provided", () => {
      const entry = createTimelineEntry("t_c2", "test", "user_dm_message");
      expect(entry.context_key).toBeNull();
    });
  });

  describe("findRunningPidByTaskId", () => {
    function writeEntry(filename: string, entry: ContextTimelineEntry) {
      const filePath = join(dir, filename);
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }
      writeFileSync(filePath, existing + JSON.stringify(entry) + "\n");
    }

    function makeEntry(overrides: Partial<ContextTimelineEntry>): ContextTimelineEntry {
      return {
        task_id: "t_1",
        context_key: null,
        session_id: null,
        pid: null,
        status: "running",
        datetime: new Date().toISOString(),
        type: "user_dm_message",
        prompt: "test",
        agent_responses: [],
        errmsg: null,
        provider: "claude",
        detailed_log: null,
        ...overrides,
      };
    }

    it("returns PID for running task", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_running",
        status: "running",
        pid: 12345,
      }));

      expect(findRunningPidByTaskId(dir, "t_running")).toBe(12345);
    });

    it("returns null for completed task", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_done",
        status: "completed",
        pid: null,
      }));

      expect(findRunningPidByTaskId(dir, "t_done")).toBeNull();
    });

    it("returns null when task not in timeline", () => {
      expect(findRunningPidByTaskId(dir, "t_nonexistent")).toBeNull();
    });

    it("returns null for running task with null pid", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_nopid",
        status: "running",
        pid: null,
      }));

      expect(findRunningPidByTaskId(dir, "t_nopid")).toBeNull();
    });

    it("returns null for killed task even with pid", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_killed",
        status: "killed",
        pid: 99999,
      }));

      expect(findRunningPidByTaskId(dir, "t_killed")).toBeNull();
    });
  });

  describe("findResumableSessionByContextKey", () => {
    function writeEntry(filename: string, entry: ContextTimelineEntry) {
      const filePath = join(dir, filename);
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }
      writeFileSync(filePath, existing + JSON.stringify(entry) + "\n");
    }

    function makeEntry(overrides: Partial<ContextTimelineEntry>): ContextTimelineEntry {
      return {
        task_id: "t_1",
        context_key: null,
        session_id: null,
        pid: null,
        status: "running",
        datetime: new Date().toISOString(),
        type: "user_dm_message",
        prompt: "test",
        agent_responses: [],
        errmsg: null,
        provider: "claude",
        ...overrides,
      };
    }

    it("returns session_id from a completed entry matching context_key", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_1",
        status: "completed",
        session_id: "sess_abc",
        context_key: "conv_1",
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionByContextKey(dir, "conv_1", "claude")).toBe("sess_abc");
    });

    it("returns null when context_key does not match", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_1",
        status: "completed",
        session_id: "sess_abc",
        context_key: "conv_1",
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionByContextKey(dir, "conv_2", "claude")).toBeNull();
    });

    it("returns null when no entries exist", () => {
      expect(findResumableSessionByContextKey(dir, "conv_1", "claude")).toBeNull();
    });

    it("uses unified 72h max age for all context keys", () => {
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_4h",
        status: "completed",
        session_id: "sess_4h",
        context_key: "conv_1",
        datetime: fourHoursAgo.toISOString(),
      }));

      // 4 hours ago is within 72h — should match
      expect(findResumableSessionByContextKey(dir, "conv_1", "claude")).toBe("sess_4h");
    });

    it("expires after 72h", () => {
      const seventyFourHoursAgo = new Date(Date.now() - 74 * 60 * 60 * 1000);
      writeEntry(_filenameForDate(seventyFourHoursAgo), makeEntry({
        task_id: "t_old",
        status: "completed",
        session_id: "sess_old",
        context_key: "conv_1",
        datetime: seventyFourHoursAgo.toISOString(),
      }));

      expect(findResumableSessionByContextKey(dir, "conv_1", "claude")).toBeNull();
    });

    it("does not use different max age for different context key types", () => {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_dm",
        status: "completed",
        session_id: "sess_dm",
        context_key: "conv_dm",
        datetime: twentyFourHoursAgo.toISOString(),
      }));
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_email",
        status: "completed",
        session_id: "sess_email",
        context_key: "conv_email",
        datetime: twentyFourHoursAgo.toISOString(),
      }));

      // Both 24h old — both within unified 72h window
      expect(findResumableSessionByContextKey(dir, "conv_dm", "claude")).toBe("sess_dm");
      expect(findResumableSessionByContextKey(dir, "conv_email", "claude")).toBe("sess_email");
    });

    it("filters by provider", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_1",
        status: "completed",
        session_id: "sess_claude",
        context_key: "conv_1",
        provider: "claude",
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionByContextKey(dir, "conv_1", "codex")).toBeNull();
      expect(findResumableSessionByContextKey(dir, "conv_1", "claude")).toBe("sess_claude");
    });

    it("returns the latest matching entry", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);

      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_older",
        status: "completed",
        session_id: "sess_older",
        context_key: "conv_1",
        datetime: twoHoursAgo.toISOString(),
      }));
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_newer",
        status: "completed",
        session_id: "sess_newer",
        context_key: "conv_1",
        datetime: oneHourAgo.toISOString(),
      }));

      expect(findResumableSessionByContextKey(dir, "conv_1", "claude")).toBe("sess_newer");
    });
  });

  describe("findRunningPidByTaskId cross-day fix", () => {
    function writeEntry(filename: string, entry: ContextTimelineEntry) {
      const filePath = join(dir, filename);
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }
      writeFileSync(filePath, existing + JSON.stringify(entry) + "\n");
    }

    function makeEntry(overrides: Partial<ContextTimelineEntry>): ContextTimelineEntry {
      return {
        task_id: "t_1",
        context_key: null,
        session_id: null,
        pid: null,
        status: "running",
        datetime: new Date().toISOString(),
        type: "user_dm_message",
        prompt: "test",
        agent_responses: [],
        errmsg: null,
        provider: "claude",
        detailed_log: null,
        ...overrides,
      };
    }

    it("finds predecessor PID from yesterday's timeline file (cross-day fix)", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      writeEntry(_filenameForDate(yesterday), makeEntry({
        task_id: "t_yesterday",
        status: "running",
        pid: 55555,
      }));

      expect(findRunningPidByTaskId(dir, "t_yesterday")).toBe(55555);
    });

    it("finds predecessor PID from 3 days ago", () => {
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      writeEntry(_filenameForDate(threeDaysAgo), makeEntry({
        task_id: "t_old",
        status: "running",
        pid: 33333,
      }));

      expect(findRunningPidByTaskId(dir, "t_old")).toBe(33333);
    });
  });

  describe("findRunningEntryByContextKey", () => {
    function writeEntry(filename: string, entry: ContextTimelineEntry) {
      const filePath = join(dir, filename);
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }
      writeFileSync(filePath, existing + JSON.stringify(entry) + "\n");
    }

    function makeEntry(overrides: Partial<ContextTimelineEntry>): ContextTimelineEntry {
      return {
        task_id: "t_1",
        context_key: null,
        session_id: null,
        pid: null,
        status: "running",
        datetime: new Date().toISOString(),
        type: "user_dm_message",
        prompt: "test",
        agent_responses: [],
        errmsg: null,
        provider: "claude",
        detailed_log: null,
        ...overrides,
      };
    }

    it("returns running entry for same context_key and provider", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_running",
        status: "running",
        pid: 12345,
        context_key: "conv_thread",
        provider: "claude",
      }));

      const entry = findRunningEntryByContextKey(dir, "conv_thread", "claude");
      expect(entry).not.toBeNull();
      expect(entry!.task_id).toBe("t_running");
      expect(entry!.pid).toBe(12345);
    });

    it("returns null when no running entries exist", () => {
      expect(findRunningEntryByContextKey(dir, "conv_thread", "claude")).toBeNull();
    });

    it("ignores non-running entries", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_done",
        status: "completed",
        context_key: "conv_thread",
        provider: "claude",
      }));

      expect(findRunningEntryByContextKey(dir, "conv_thread", "claude")).toBeNull();
    });

    it("ignores different provider", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_codex",
        status: "running",
        pid: 22222,
        context_key: "conv_thread",
        provider: "codex",
      }));

      expect(findRunningEntryByContextKey(dir, "conv_thread", "claude")).toBeNull();
    });

    it("ignores different context_key", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_other",
        status: "running",
        pid: 33333,
        context_key: "conv_other",
        provider: "claude",
      }));

      expect(findRunningEntryByContextKey(dir, "conv_thread", "claude")).toBeNull();
    });

    it("returns the newest running entry for same context_key", () => {
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
      const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000);

      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_older",
        status: "running",
        pid: 11111,
        context_key: "conv_thread",
        provider: "claude",
        datetime: twoMinAgo.toISOString(),
      }));
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_newer",
        status: "running",
        pid: 22222,
        context_key: "conv_thread",
        provider: "claude",
        datetime: oneMinAgo.toISOString(),
      }));

      const entry = findRunningEntryByContextKey(dir, "conv_thread", "claude");
      expect(entry!.task_id).toBe("t_newer");
    });

    it("scans up to 7 days for running entries", () => {
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      writeEntry(_filenameForDate(threeDaysAgo), makeEntry({
        task_id: "t_old_running",
        status: "running",
        pid: 44444,
        context_key: "conv_thread",
        provider: "claude",
        datetime: threeDaysAgo.toISOString(),
      }));

      const entry = findRunningEntryByContextKey(dir, "conv_thread", "claude");
      expect(entry!.task_id).toBe("t_old_running");
    });

    it("null context_key tasks are never matched", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_null_ctx",
        status: "running",
        pid: 55555,
        context_key: null,
        provider: "claude",
      }));

      expect(findRunningEntryByContextKey(dir, "conv_1", "claude")).toBeNull();
    });
  });

  describe("superseded timeline entry status", () => {
    it("updateEntry can set status to superseded", () => {
      const entry = createTimelineEntry("t_sup", "test", TASK_TYPES.USER_DM_MESSAGE);
      initEntry(dir, entry);

      updateEntry(dir, "t_sup", (e) => {
        e.pid = null;
        e.status = "superseded";
        e.successor_task_id = "t_new";
        e.supersede_reason = "superseded by newer task";
      });

      const entries = readEntries();
      expect(entries[0].status).toBe("superseded");
      expect(entries[0].successor_task_id).toBe("t_new");
      expect(entries[0].supersede_reason).toBe("superseded by newer task");
    });

    it("updateEntry can set status to cancelled", () => {
      const entry = createTimelineEntry("t_can", "test", TASK_TYPES.USER_DM_MESSAGE);
      initEntry(dir, entry);

      updateEntry(dir, "t_can", (e) => {
        e.pid = null;
        e.status = "cancelled";
        e.errmsg = "cancelled by user";
      });

      const entries = readEntries();
      expect(entries[0].status).toBe("cancelled");
      expect(entries[0].errmsg).toBe("cancelled by user");
    });
  });
});
