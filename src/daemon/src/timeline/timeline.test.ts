import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendEntry,
  appendOrMergeEntry,
  updateLatestEntry,
  readRecentEntries,
  createTimelineEntry,
  createSystemEntry,
  findResumableSession,
  filenameForDate,
  localISOString,
} from "./timeline";
import type { Message } from "../server/contract";

const tmpDirs: string[] = [];
function mkDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "timeline-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = new Date("2026-06-25T12:00:00");
const msg = (text: string): Message => ({
  seq: "#1",
  channel: "/srv/general",
  sender: "@gustavo",
  content: { text },
  time: "2026-06-25T12:00:00+00:00",
});

describe("timeline append / read (4-field schema)", () => {
  it("appends entries and reads them back in append (time) order", () => {
    const dir = mkDir();
    appendEntry(dir, createTimelineEntry({ messages: [msg("a")], provider: "claude" }), NOW);
    appendEntry(dir, createTimelineEntry({ messages: [msg("b")], provider: "claude" }), NOW);
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows.map((r) => r.messages[0].content.text)).toEqual(["a", "b"]);
    expect(Object.keys(rows[0]).sort()).toEqual(["agent_responses", "messages", "provider", "session_id"]);
    expect(fs.existsSync(path.join(dir, filenameForDate(NOW)))).toBe(true);
  });

  it("skips malformed lines instead of throwing", () => {
    const dir = mkDir();
    fs.writeFileSync(
      path.join(dir, filenameForDate(NOW)),
      '{"bad json\n{"session_id":"ok","messages":[],"agent_responses":[],"provider":null}\n',
    );
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows.map((r) => r.session_id)).toEqual(["ok"]);
  });
});

describe("appendOrMergeEntry", () => {
  it("merges into the latest row when session/provider match and it has no responses", () => {
    const dir = mkDir();
    appendOrMergeEntry(dir, createTimelineEntry({ messages: [msg("a")], sessionId: "s1", provider: "claude" }), NOW);
    appendOrMergeEntry(dir, createTimelineEntry({ messages: [msg("b")], sessionId: "s1", provider: "claude" }), NOW);
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].messages.map((m) => m.content.text)).toEqual(["a", "b"]);
  });

  it("appends a new row once the latest has a response", () => {
    const dir = mkDir();
    appendOrMergeEntry(dir, createTimelineEntry({ messages: [msg("a")], sessionId: "s1", provider: "claude" }), NOW);
    updateLatestEntry(dir, (e) => e.agent_responses.push("done"), { now: NOW });
    appendOrMergeEntry(dir, createTimelineEntry({ messages: [msg("b")], sessionId: "s1", provider: "claude" }), NOW);
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows).toHaveLength(2);
  });

  it("appends a new row when session_id or provider differs", () => {
    const dir = mkDir();
    appendOrMergeEntry(dir, createTimelineEntry({ messages: [msg("a")], sessionId: "s1", provider: "claude" }), NOW);
    appendOrMergeEntry(dir, createTimelineEntry({ messages: [msg("b")], sessionId: "s2", provider: "claude" }), NOW);
    expect(readRecentEntries(dir, { now: NOW })).toHaveLength(2);
  });
});

describe("updateLatestEntry", () => {
  it("mutates the most-recent row and persists it", () => {
    const dir = mkDir();
    appendEntry(dir, createTimelineEntry({ messages: [msg("a")] }), NOW);
    appendEntry(dir, createTimelineEntry({ messages: [msg("b")] }), NOW);
    const ok = updateLatestEntry(dir, (e) => e.agent_responses.push("reply"), { now: NOW });
    expect(ok).toBe(true);
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows[0].agent_responses).toEqual([]); // older row untouched
    expect(rows[1].agent_responses).toEqual(["reply"]); // latest got the response
  });

  it("returns false when there is no entry yet", () => {
    const dir = mkDir();
    expect(updateLatestEntry(dir, () => {}, { now: NOW })).toBe(false);
  });

  it("returns false when the newest row is a system barrier (does NOT walk past it into a pre-barrier turn)", () => {
    const dir = mkDir();
    appendEntry(dir, createTimelineEntry({ messages: [msg("a")], sessionId: "s1", provider: "claude" }), NOW);
    appendEntry(dir, createSystemEntry("reset_session", "2026-06-25T12:00:00Z"), NOW);
    let mutated = false;
    const ok = updateLatestEntry(dir, () => { mutated = true; }, { now: NOW });
    expect(ok).toBe(false);
    expect(mutated).toBe(false);
    const rows = readRecentEntries(dir, { now: NOW });
    // Neither row was touched — barrier stays clean, pre-barrier turn stays clean.
    expect(rows[0].agent_responses).toEqual([]);
    expect(rows[1].system?.type).toBe("reset_session");
    expect(rows[1].agent_responses).toEqual([]);
  });

  it("returns false when the file has only system rows (no turn row to update)", () => {
    const dir = mkDir();
    appendEntry(dir, createSystemEntry("reset_session", "2026-06-25T12:00:00Z"), NOW);
    expect(updateLatestEntry(dir, () => {}, { now: NOW })).toBe(false);
  });
});

describe("findResumableSession", () => {
  it("returns the latest session id (rows are in time order)", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-old" }) },
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-new" }) },
    ];
    expect(findResumableSession(rows)).toBe("s-new");
  });

  it("can constrain to a provider so it won't resume across runtimes", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-claude" }) },
      { ...createTimelineEntry({ messages: [], provider: "codex", sessionId: "s-codex" }) },
    ];
    expect(findResumableSession(rows, "claude")).toBe("s-claude");
  });

  it("returns null when no row carries a session id", () => {
    const rows = [{ ...createTimelineEntry({ messages: [], provider: "claude" }) }];
    expect(findResumableSession(rows)).toBeNull();
  });

  it("stops on a reset_session barrier row and returns null", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-old" }) },
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-old" }) },
      createSystemEntry("reset_session", "2026-06-25T12:00:00Z"),
    ];
    expect(findResumableSession(rows)).toBeNull();
  });

  it("returns a session id from a row appended AFTER the barrier", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-old" }) },
      createSystemEntry("reset_session", "2026-06-25T12:00:00Z"),
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-new" }) },
    ];
    expect(findResumableSession(rows)).toBe("s-new");
  });

  it("multiple resets: newest barrier stops the walk", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-1" }) },
      createSystemEntry("reset_session", "2026-06-25T12:00:00Z"),
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-2" }) },
      createSystemEntry("reset_session", "2026-06-25T12:01:00Z"),
    ];
    expect(findResumableSession(rows)).toBeNull();
  });

  it("provider constraint respected across a barrier", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-claude" }) },
      createSystemEntry("reset_session", "2026-06-25T12:00:00Z"),
    ];
    expect(findResumableSession(rows, "claude")).toBeNull();
  });
});

describe("localISOString", () => {
  it("formats local time with milliseconds and a timezone offset", () => {
    expect(localISOString(NOW)).toMatch(/^2026-06-25T12:00:00\.000[+-]\d{2}:\d{2}$/);
  });
});
