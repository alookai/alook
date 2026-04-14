import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock logger to prevent noise
vi.mock("../../../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  initEntry,
  updateEntry,
  createTimelineEntry,
  findResumableSessionId,
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
    const entry = createTimelineEntry("t_abc", "do something");
    initEntry(dir, entry);

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].task_id).toBe("t_abc");
    expect(entries[0].session_id).toBeNull();
    expect(entries[0].pid).toBeNull();
    expect(entries[0].status).toBe("running");
    expect(entries[0].prompt).toBe("do something");
    expect(entries[0].type).toBe("user_dm_message");
    expect(entries[0].steps).toEqual([]);
    expect(entries[0].response).toBeNull();
    expect(entries[0].errmsg).toBeNull();
  });

  it("createTimelineEntry stores sessionId and pid when provided", () => {
    const entry = createTimelineEntry("t_xyz", "test", "sess_1", 99999);
    initEntry(dir, entry);

    const entries = readEntries();
    expect(entries[0].session_id).toBe("sess_1");
    expect(entries[0].pid).toBe(99999);
  });

  it("updateEntry finds entry by task_id and updates steps", () => {
    const entry = createTimelineEntry("t_abc", "do something");
    initEntry(dir, entry);

    updateEntry(dir, "t_abc", (e) => {
      e.steps.push("Step 1: Looking at the code...");
    });

    const entries = readEntries();
    expect(entries[0].steps).toEqual(["Step 1: Looking at the code..."]);
  });

  it("updateEntry sets completion fields correctly", () => {
    const entry = createTimelineEntry("t_abc", "do something");
    initEntry(dir, entry);

    updateEntry(dir, "t_abc", (e) => {
      e.session_id = "sess_123";
      e.pid = null;
      e.status = "completed";
      e.response = "Done! Here is the result.";
    });

    const entries = readEntries();
    expect(entries[0].session_id).toBe("sess_123");
    expect(entries[0].pid).toBeNull();
    expect(entries[0].status).toBe("completed");
    expect(entries[0].response).toBe("Done! Here is the result.");
    expect(entries[0].errmsg).toBeNull();
  });

  it("updateEntry sets failure fields correctly", () => {
    const entry = createTimelineEntry("t_fail", "will fail");
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
    expect(entries[0].response).toBeNull();
  });

  it("multiple entries for different task_ids coexist in same file", () => {
    initEntry(dir, createTimelineEntry("t_1", "first task"));
    initEntry(dir, createTimelineEntry("t_2", "second task"));
    initEntry(dir, createTimelineEntry("t_3", "third task"));

    const entries = readEntries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.task_id)).toEqual(["t_1", "t_2", "t_3"]);
  });

  it("updateEntry only modifies the matching task_id", () => {
    initEntry(dir, createTimelineEntry("t_1", "first task"));
    initEntry(dir, createTimelineEntry("t_2", "second task"));

    updateEntry(dir, "t_2", (e) => {
      e.steps.push("Working on second task");
    });

    const entries = readEntries();
    expect(entries[0].steps).toEqual([]);
    expect(entries[1].steps).toEqual(["Working on second task"]);
  });

  it("timeline operations are best-effort — errors don't propagate", () => {
    // updateEntry on a non-existent directory should not throw
    expect(() => updateEntry("/nonexistent/path", "t_1", (e) => { e.steps.push("x"); })).not.toThrow();
  });

  it("updateEntry is a no-op when task_id not found", () => {
    initEntry(dir, createTimelineEntry("t_1", "task"));

    updateEntry(dir, "t_nonexistent", (e) => {
      e.steps.push("should not happen");
    });

    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].steps).toEqual([]);
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
    const entry = createTimelineEntry("t_old", "old task");
    const filePath = join(dir, filename);
    writeFileSync(filePath, JSON.stringify(entry) + "\n");

    // updateEntry should find it even though it's not in today's file
    updateEntry(dir, "t_old", (e) => {
      e.steps.push("Updated across midnight");
    });

    const content = readFileSync(filePath, "utf-8");
    const updated: ContextTimelineEntry = JSON.parse(content.trimEnd());
    expect(updated.steps).toEqual(["Updated across midnight"]);
  });

  it("updateEntry stops at first match and does not modify older files", () => {
    // Write same task_id in two different day files
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const todayFile = join(dir, _todayFilename());
    const yesterdayFile = join(dir, _filenameForDate(yesterday));

    const entryToday = createTimelineEntry("t_dup", "today version");
    const entryYesterday = createTimelineEntry("t_dup", "yesterday version");
    writeFileSync(todayFile, JSON.stringify(entryToday) + "\n");
    writeFileSync(yesterdayFile, JSON.stringify(entryYesterday) + "\n");

    updateEntry(dir, "t_dup", (e) => {
      e.response = "done";
    });

    // Today's file should be updated
    const todayParsed: ContextTimelineEntry = JSON.parse(readFileSync(todayFile, "utf-8").trimEnd());
    expect(todayParsed.response).toBe("done");

    // Yesterday's should be untouched
    const yesterdayParsed: ContextTimelineEntry = JSON.parse(readFileSync(yesterdayFile, "utf-8").trimEnd());
    expect(yesterdayParsed.response).toBeNull();
  });

  it("updateEntry is a no-op when task_id not found in any day", () => {
    // Write entries for today and yesterday with different task_ids
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    writeFileSync(join(dir, _todayFilename()), JSON.stringify(createTimelineEntry("t_a", "a")) + "\n");
    writeFileSync(join(dir, _filenameForDate(yesterday)), JSON.stringify(createTimelineEntry("t_b", "b")) + "\n");

    // Should not throw, just silently no-op
    updateEntry(dir, "t_nonexistent", (e) => {
      e.steps.push("nope");
    });

    // Verify nothing changed
    const todayEntries = JSON.parse(readFileSync(join(dir, _todayFilename()), "utf-8").trimEnd());
    expect(todayEntries.steps).toEqual([]);
  });

  describe("findResumableSessionId", () => {
    function writeEntry(filename: string, entry: ContextTimelineEntry) {
      const filePath = join(dir, filename);
      let existing = "";
      try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }
      writeFileSync(filePath, existing + JSON.stringify(entry) + "\n");
    }

    function makeEntry(overrides: Partial<ContextTimelineEntry>): ContextTimelineEntry {
      return {
        task_id: "t_1",
        session_id: null,
        pid: null,
        status: "running",
        datetime: new Date().toISOString(),
        type: "user_dm_message",
        prompt: "test",
        steps: [],
        response: null,
        errmsg: null,
        ...overrides,
      };
    }

    it("returns session_id from a completed entry of matching type within 3h", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_1",
        status: "completed",
        session_id: "sess_abc",
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBe("sess_abc");
    });

    it("returns null when no entries exist", () => {
      expect(findResumableSessionId(dir, "user_dm_message")).toBeNull();
    });

    it("returns null when no timeline files exist", () => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      expect(findResumableSessionId(dir, "user_dm_message")).toBeNull();
    });

    it("returns null when the latest completed entry is older than 3h", () => {
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_old",
        status: "completed",
        session_id: "sess_old",
        datetime: fourHoursAgo.toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBeNull();
    });

    it("returns null when session_id is null on the entry", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_nosess",
        status: "completed",
        session_id: null,
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBeNull();
    });

    it("skips failed/running entries and finds the correct completed one", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_completed",
        status: "completed",
        session_id: "sess_good",
        datetime: new Date().toISOString(),
      }));
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_running",
        status: "running",
        session_id: null,
        datetime: new Date().toISOString(),
      }));
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_failed",
        status: "failed",
        session_id: "sess_bad",
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBe("sess_good");
    });

    it("searches across midnight boundary (yesterday's file)", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      writeEntry(_filenameForDate(yesterday), makeEntry({
        task_id: "t_yesterday",
        status: "completed",
        session_id: "sess_yesterday",
        datetime: twoHoursAgo.toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBe("sess_yesterday");
    });

    it("returns the latest match, not the first one in file order", () => {
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_older",
        status: "completed",
        session_id: "sess_older",
        datetime: twoHoursAgo.toISOString(),
      }));
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_newer",
        status: "completed",
        session_id: "sess_newer",
        datetime: oneHourAgo.toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBe("sess_newer");
    });

    it("respects custom maxAgeMs parameter", () => {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_recent",
        status: "completed",
        session_id: "sess_recent",
        datetime: thirtyMinAgo.toISOString(),
      }));

      // 10 minute window — entry is 30 min old, should not match
      expect(findResumableSessionId(dir, "user_dm_message", 10 * 60 * 1000)).toBeNull();
      // 60 minute window — entry is 30 min old, should match
      expect(findResumableSessionId(dir, "user_dm_message", 60 * 60 * 1000)).toBe("sess_recent");
    });

    it("does not match a different task type", () => {
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_1",
        status: "completed",
        session_id: "sess_dm",
        type: "user_dm_message",
        datetime: new Date().toISOString(),
      }));

      expect(findResumableSessionId(dir, "scheduled_check")).toBeNull();
    });

    it("finds the latest entry across midnight boundary correctly", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000);
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

      // Yesterday's entry is older but still within 3h
      writeEntry(_filenameForDate(yesterday), makeEntry({
        task_id: "t_yesterday",
        status: "completed",
        session_id: "sess_yesterday",
        datetime: ninetyMinAgo.toISOString(),
      }));
      // Today's entry is newer
      writeEntry(_todayFilename(), makeEntry({
        task_id: "t_today",
        status: "completed",
        session_id: "sess_today",
        datetime: thirtyMinAgo.toISOString(),
      }));

      expect(findResumableSessionId(dir, "user_dm_message")).toBe("sess_today");
    });
  });
});
