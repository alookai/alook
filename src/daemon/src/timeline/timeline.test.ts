import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendEntry,
  appendOrMergeEntry,
  updateLatestEntry,
  updateLatestEntryResult,
  readRecentEntries,
  createTimelineEntry,
  createSystemEntry,
  findResumableSession,
  filenameForDate,
  localISOString,
  sweepTimelineHistory,
  TIMELINE_MAX_BYTES,
} from "./timeline";
import { acquireLock, lockPathFor, releaseLock } from "./filelock";
import type { Message } from "../server/contract";

const tmpDirs: string[] = [];
function mkDir(): string {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "timeline-"));
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

function entryWithPayloadBytes(payloadBytes: number, sessionId: string | null = "s1", provider = "claude") {
  return createTimelineEntry({ messages: [msg("x".repeat(payloadBytes))], sessionId, provider });
}

function entryAtExactBytes(bytes: number) {
  const empty = entryWithPayloadBytes(0);
  const overhead = Buffer.byteLength(JSON.stringify(empty), "utf8") + 1;
  return entryWithPayloadBytes(bytes - overhead);
}

function entryAtExactBytesWithMultibyte(bytes: number) {
  const multibyte = "界".repeat(64);
  const base = createTimelineEntry({ messages: [msg(multibyte)], sessionId: "utf8", provider: "claude" });
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8") + 1;
  return createTimelineEntry({
    messages: [msg(multibyte + "x".repeat(bytes - baseBytes))],
    sessionId: "utf8",
    provider: "claude",
  });
}

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

  it("rejects an over-cap merge and leaves the source bytes unchanged", () => {
    const dir = mkDir();
    const original = createTimelineEntry({ messages: [msg("original")], sessionId: "s1", provider: "claude" });
    expect(appendOrMergeEntry(dir, original, NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    const before = fs.readFileSync(file);
    const oversized = createTimelineEntry({
      messages: [msg("界".repeat(TIMELINE_MAX_BYTES))],
      sessionId: "s1",
      provider: "claude",
    });

    expect(appendOrMergeEntry(dir, oversized, NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("converges an oversized historical file after a successful merge", () => {
    const dir = mkDir();
    const file = path.join(dir, filenameForDate(NOW));
    const rows = Array.from({ length: 5 }, (_, index) =>
      entryWithPayloadBytes(240_000, index === 4 ? "merge" : `s${index}`));
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    expect(appendOrMergeEntry(
      dir,
      createTimelineEntry({ messages: [msg("merged")], sessionId: "merge", provider: "claude" }),
      NOW,
    )).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(readRecentEntries(dir, { now: NOW }).at(-1)?.messages.at(-1)?.content.text).toBe("merged");
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

  it("rejects an over-cap update and leaves the source bytes unchanged", () => {
    const dir = mkDir();
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("original")] }), NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    const before = fs.readFileSync(file);

    expect(updateLatestEntry(
      dir,
      (entry) => entry.agent_responses.push("界".repeat(TIMELINE_MAX_BYTES)),
      { now: NOW },
    )).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("does not fall back to an older day after the latest-day update is rejected", () => {
    const dir = mkDir();
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("yesterday")] }), yesterday)).toBe(true);
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("today")] }), NOW)).toBe(true);
    const yesterdayFile = path.join(dir, filenameForDate(yesterday));
    const todayFile = path.join(dir, filenameForDate(NOW));
    const beforeYesterday = fs.readFileSync(yesterdayFile);
    const beforeToday = fs.readFileSync(todayFile);
    let updateCalls = 0;

    expect(updateLatestEntry(dir, (entry) => {
      updateCalls++;
      entry.agent_responses.push("界".repeat(TIMELINE_MAX_BYTES));
    }, { now: NOW })).toBe(false);
    expect(updateCalls).toBe(1);
    expect(fs.readFileSync(todayFile)).toEqual(beforeToday);
    expect(fs.readFileSync(yesterdayFile)).toEqual(beforeYesterday);
  });

  it("rejects a busy latest-day lock without updating or falling back to yesterday", () => {
    const dir = mkDir();
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("yesterday")] }), yesterday)).toBe(true);
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("today")] }), NOW)).toBe(true);
    const yesterdayFile = path.join(dir, filenameForDate(yesterday));
    const todayFilename = filenameForDate(NOW);
    const todayFile = path.join(dir, todayFilename);
    const beforeYesterday = fs.readFileSync(yesterdayFile);
    const beforeToday = fs.readFileSync(todayFile);
    const lock = lockPathFor(dir, todayFilename);
    let updateCalls = 0;
    expect(acquireLock(lock)).toBe(true);
    try {
      expect(updateLatestEntryResult(dir, () => { updateCalls++; }, { now: NOW })).toBe("rejected");
    } finally {
      releaseLock(lock);
    }

    expect(updateCalls).toBe(0);
    expect(fs.readFileSync(todayFile)).toEqual(beforeToday);
    expect(fs.readFileSync(yesterdayFile)).toEqual(beforeYesterday);
  });

  it("converges an oversized historical file after a successful update", () => {
    const dir = mkDir();
    const file = path.join(dir, filenameForDate(NOW));
    const rows = Array.from({ length: 5 }, (_, index) => entryWithPayloadBytes(240_000, `s${index}`));
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    expect(updateLatestEntry(dir, (entry) => entry.agent_responses.push("updated"), { now: NOW })).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(readRecentEntries(dir, { now: NOW }).at(-1)?.agent_responses).toEqual(["updated"]);
  });
});

describe("daily timeline hard cap", () => {
  it("evicts oldest complete rows and keeps valid ordered JSONL at or below exactly 1 MiB", () => {
    const dir = mkDir();
    for (let index = 0; index < 6; index++) {
      expect(appendEntry(dir, entryWithPayloadBytes(240_000, `s${index}`), NOW)).toBe(true);
    }
    const file = path.join(dir, filenameForDate(NOW));
    expect(fs.statSync(file).size).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    const physical = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(() => physical.map((line) => JSON.parse(line))).not.toThrow();
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows.map((row) => row.session_id)).toEqual(["s2", "s3", "s4", "s5"]);
  });

  it("rejects an over-cap prospective row and leaves the original bytes unchanged", () => {
    const dir = mkDir();
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("original")] }), NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    const before = fs.readFileSync(file);
    expect(appendEntry(dir, entryWithPayloadBytes(TIMELINE_MAX_BYTES), NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("uses UTF-8 byte length at the exact cap and rejects a multibyte overflow", () => {
    const dir = mkDir();
    const exact = entryAtExactBytesWithMultibyte(TIMELINE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8") + 1).toBe(TIMELINE_MAX_BYTES);
    expect(appendEntry(dir, exact, NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    expect(fs.statSync(file).size).toBe(TIMELINE_MAX_BYTES);
    const before = fs.readFileSync(file);
    const overflow = createTimelineEntry({
      messages: [msg(`${exact.messages[0].content.text}界`)],
      sessionId: "utf8",
      provider: "claude",
    });

    expect(Buffer.byteLength(JSON.stringify(overflow), "utf8") + 1).toBe(TIMELINE_MAX_BYTES + 3);
    expect(appendEntry(dir, overflow, NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("rejects a newest row that fits alone but cannot coexist with the required barrier sentinel", () => {
    const dir = mkDir();
    const barrier = createSystemEntry("reset_session", "2026-06-25T12:00:00Z");
    expect(appendEntry(dir, barrier, NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    const before = fs.readFileSync(file);
    const candidate = entryAtExactBytes(TIMELINE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1).toBe(TIMELINE_MAX_BYTES);
    expect(appendEntry(dir, candidate, NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("historical convergence keeps the barrier and drops an ordinary row that cannot coexist", async () => {
    const base = mkDir();
    const dir = path.join(base, "agent-a", ".context_timeline");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filenameForDate(NOW));
    const barrier = createSystemEntry("nap", "2026-06-25T12:00:00Z");
    const ordinary = entryAtExactBytes(TIMELINE_MAX_BYTES);
    fs.writeFileSync(file, `${JSON.stringify(barrier)}\n${JSON.stringify(ordinary)}\n`);

    await sweepTimelineHistory(base, { yieldAfterFile: async () => {} });

    expect(fs.statSync(file).size).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].system?.type).toBe("nap");
  });

  it("discards a complete historical row that alone exceeds the cap", async () => {
    const base = mkDir();
    const dir = path.join(base, "agent-a", ".context_timeline");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filenameForDate(NOW));
    const oversized = entryWithPayloadBytes(TIMELINE_MAX_BYTES + 1);
    fs.writeFileSync(file, `${JSON.stringify(oversized)}\n`);
    expect(fs.statSync(file).size).toBeGreaterThan(TIMELINE_MAX_BYTES);

    await sweepTimelineHistory(base, { yieldAfterFile: async () => {} });

    expect(fs.statSync(file).size).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(readRecentEntries(dir, { now: NOW })).toEqual([]);
  });

  it("keeps only the latest barrier from an evicted prefix", async () => {
    const base = mkDir();
    const dir = path.join(base, "agent-a", ".context_timeline");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filenameForDate(NOW));
    const rows = [
      createSystemEntry("reset_session", "2026-06-25T10:00:00Z"),
      entryWithPayloadBytes(300_000, "between"),
      createSystemEntry("nap", "2026-06-25T11:00:00Z"),
      ...Array.from({ length: 5 }, (_, index) => entryWithPayloadBytes(240_000, `new-${index}`)),
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    await sweepTimelineHistory(base, { yieldAfterFile: async () => {} });

    const retained = readRecentEntries(dir, { now: NOW });
    expect(retained.filter((row) => row.system).map((row) => row.system?.type)).toEqual(["nap"]);
    expect(retained[0].system?.time).toBe("2026-06-25T11:00:00Z");
  });

  it("does not copy an evicted barrier when the retained suffix has a newer one", async () => {
    const base = mkDir();
    const dir = path.join(base, "agent-a", ".context_timeline");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filenameForDate(NOW));
    const rows = [
      createSystemEntry("reset_session", "2026-06-25T10:00:00Z"),
      ...Array.from({ length: 5 }, (_, index) => entryWithPayloadBytes(240_000, `middle-${index}`)),
      createSystemEntry("nap", "2026-06-25T11:00:00Z"),
      entryWithPayloadBytes(100_000, "newest"),
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

    await sweepTimelineHistory(base, { yieldAfterFile: async () => {} });

    const retained = readRecentEntries(dir, { now: NOW });
    expect(retained.filter((row) => row.system).map((row) => row.system?.type)).toEqual(["nap"]);
    expect(retained.find((row) => row.system)?.system?.time).toBe("2026-06-25T11:00:00Z");
  });

  it("keeps the latest evicted barrier across days and resumes only a newer matching-provider session", () => {
    const dir = mkDir();
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("old")], sessionId: "s-old", provider: "claude" }), yesterday)).toBe(true);
    expect(appendEntry(dir, createSystemEntry("reset_session", "2026-06-25T10:00:00Z"), NOW)).toBe(true);
    for (let index = 0; index < 6; index++) {
      expect(appendEntry(dir, entryWithPayloadBytes(220_000, null, "codex"), NOW)).toBe(true);
    }
    expect(findResumableSession(readRecentEntries(dir, { maxDays: 2, now: NOW }), "claude")).toBeNull();

    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("new")], sessionId: "s-new", provider: "codex" }), NOW)).toBe(true);
    const rows = readRecentEntries(dir, { maxDays: 2, now: NOW });
    expect(findResumableSession(rows, "codex")).toBe("s-new");
    expect(findResumableSession(rows, "claude")).toBeNull();
  });
});

describe("timeline convergence filesystem boundaries", () => {
  it("rejects reads and writes through an intermediate agent-directory symlink", () => {
    if (process.platform === "win32") return;
    const base = mkDir();
    const outsideAgent = mkDir();
    const outsideTimeline = path.join(outsideAgent, ".context_timeline");
    fs.mkdirSync(outsideTimeline);
    const file = path.join(outsideTimeline, filenameForDate(NOW));
    fs.writeFileSync(file, `${JSON.stringify(createTimelineEntry({
      messages: [msg("outside")],
      sessionId: "outside-session",
      provider: "claude",
    }))}\n`);
    const before = fs.readFileSync(file);
    const agentLink = path.join(base, "agent-link");
    fs.symlinkSync(outsideAgent, agentLink);
    const linkedTimeline = path.join(agentLink, ".context_timeline");

    expect(readRecentEntries(linkedTimeline, { now: NOW })).toEqual([]);
    expect(appendEntry(linkedTimeline, createTimelineEntry({ messages: [msg("blocked")] }), NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("rejects normal appends through a timeline directory symlink or daily file symlink", () => {
    if (process.platform === "win32") return;
    const base = mkDir();
    const outside = mkDir();
    const filename = filenameForDate(NOW);
    const outsideTimelineFile = path.join(outside, filename);
    fs.writeFileSync(outsideTimelineFile, "outside timeline unchanged\n");
    const timelineLink = path.join(base, "timeline-link");
    fs.symlinkSync(outside, timelineLink);
    const beforeTimelineTarget = fs.readFileSync(outsideTimelineFile);

    expect(appendEntry(timelineLink, createTimelineEntry({ messages: [msg("blocked-dir-link")] }), NOW)).toBe(false);
    expect(fs.readFileSync(outsideTimelineFile)).toEqual(beforeTimelineTarget);

    const realTimeline = path.join(base, "real-timeline");
    fs.mkdirSync(realTimeline);
    const outsideDailyTarget = path.join(outside, "daily-target.jsonl");
    fs.writeFileSync(outsideDailyTarget, "outside daily unchanged\n");
    fs.symlinkSync(outsideDailyTarget, path.join(realTimeline, filename));
    const beforeDailyTarget = fs.readFileSync(outsideDailyTarget);

    expect(appendEntry(realTimeline, createTimelineEntry({ messages: [msg("blocked-file-link")] }), NOW)).toBe(false);
    expect(fs.readFileSync(outsideDailyTarget)).toEqual(beforeDailyTarget);
  });

  it("ignores a pre-existing fixed-temp symlink and atomically replaces through a random 0600 temp", () => {
    if (process.platform === "win32") return;
    const dir = mkDir();
    const outside = mkDir();
    const filename = filenameForDate(NOW);
    const file = path.join(dir, filename);
    const fixedTemp = path.join(dir, `.${filename}.tmp`);
    const outsideTarget = path.join(outside, "target.txt");
    fs.writeFileSync(outsideTarget, "outside unchanged\n");
    fs.symlinkSync(outsideTarget, fixedTemp);
    expect(appendEntry(
      dir,
      createTimelineEntry({ messages: [msg("first")], sessionId: "s1", provider: "claude" }),
      NOW,
    )).toBe(true);

    expect(appendOrMergeEntry(
      dir,
      createTimelineEntry({ messages: [msg("second")], sessionId: "s1", provider: "claude" }),
      NOW,
    )).toBe(true);

    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("outside unchanged\n");
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(fixedTemp).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.startsWith(`.${filename}.`) && name !== `.${filename}.tmp`)).toEqual([]);
  });

  it("drops malformed rows and an incomplete tail, then writes only parseable lines", async () => {
    const base = mkDir();
    const dir = path.join(base, "agent-a", ".context_timeline");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filenameForDate(NOW));
    fs.writeFileSync(
      file,
      `${JSON.stringify(createTimelineEntry({ messages: [msg("old")] }))}\n{bad json}\n${JSON.stringify(createTimelineEntry({ messages: [msg("new")] }))}\n${JSON.stringify(createTimelineEntry({ messages: [msg("incomplete")] }))}`,
    );

    await sweepTimelineHistory(base, { yieldAfterFile: async () => {} });

    const physical = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    expect(physical.map((line) => JSON.parse(line)).map((row) => row.messages[0].content.text)).toEqual(["old", "new"]);
  });

  it("skips a held lock and the next normal write converges the file", async () => {
    const base = mkDir();
    const dir = path.join(base, "agent-a", ".context_timeline");
    fs.mkdirSync(dir, { recursive: true });
    const filename = filenameForDate(NOW);
    const file = path.join(dir, filename);
    fs.writeFileSync(file, Array.from({ length: 6 }, (_, index) => JSON.stringify(entryWithPayloadBytes(240_000, `s${index}`))).join("\n") + "\n");
    const lock = lockPathFor(dir, filename);
    const yielded: string[] = [];
    expect(acquireLock(lock)).toBe(true);
    try {
      await sweepTimelineHistory(base, { yieldAfterFile: async (filePath) => { yielded.push(filePath); } });
      expect(fs.statSync(file).size).toBeGreaterThan(TIMELINE_MAX_BYTES);
    } finally {
      releaseLock(lock);
    }
    expect(yielded).toEqual([file]);

    expect(appendEntry(dir, createTimelineEntry({ messages: [msg("latest")], sessionId: "latest" }), NOW)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(readRecentEntries(dir, { now: NOW }).at(-1)?.session_id).toBe("latest");
  });

  it("sorts every exact immediate-child file and rejects directory/file symlinks", async () => {
    if (process.platform === "win32") return;
    const base = mkDir();
    const outside = mkDir();
    const outsideFile = path.join(outside, filenameForDate(NOW));
    fs.writeFileSync(outsideFile, `${JSON.stringify(createTimelineEntry({ messages: [msg("outside")] }))}\n`);
    fs.symlinkSync(outside, path.join(base, "agent-link"));
    fs.mkdirSync(path.join(base, "agent-timeline-link"));
    fs.symlinkSync(outside, path.join(base, "agent-timeline-link", ".context_timeline"));

    for (const agent of ["agent-b", "agent-a"]) {
      const dir = path.join(base, agent, ".context_timeline");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "2026-06-24.jsonl"), `${JSON.stringify(createTimelineEntry({ messages: [msg(agent)] }))}\n`);
    }
    const dateNamedDirectory = path.join(base, "agent-b", ".context_timeline", filenameForDate(NOW));
    fs.mkdirSync(dateNamedDirectory);
    const dailyTarget = path.join(outside, "daily-target.jsonl");
    fs.writeFileSync(dailyTarget, "target unchanged\n");
    fs.symlinkSync(dailyTarget, path.join(base, "agent-a", ".context_timeline", filenameForDate(NOW)));
    fs.writeFileSync(path.join(base, "agent-a", ".context_timeline", "not-a-date.jsonl"), "ignored\n");
    const yielded: string[] = [];

    await sweepTimelineHistory(base, { yieldAfterFile: async (filePath) => { yielded.push(filePath); } });

    expect(yielded.map((filePath) => path.relative(base, filePath))).toEqual([
      path.join("agent-a", ".context_timeline", "2026-06-24.jsonl"),
      path.join("agent-b", ".context_timeline", "2026-06-24.jsonl"),
    ]);
    expect(fs.readFileSync(outsideFile, "utf8")).toContain("outside");
    expect(fs.readFileSync(dailyTarget, "utf8")).toBe("target unchanged\n");
    expect(fs.lstatSync(dateNamedDirectory).isDirectory()).toBe(true);
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

  it("stops on a nap barrier row and returns null (agent self-reset is a barrier too)", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "claude", sessionId: "s-old" }) },
      createSystemEntry("nap", "2026-06-25T12:00:00Z"),
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
