import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "os";
import * as path from "path";
import {
  appendTrackedEntry,
  updateTrackedEntry,
  refreshTimelineEntryHandle,
  readRecentEntries,
  createTimelineEntry,
  createSystemEntry,
  findResumableSession,
  resolveResumableSession,
  filenameForDate,
  localISOString,
  sweepTimelineHistory,
  TIMELINE_MAX_BYTES,
} from "./timeline";
import type { TimelineEntryHandle } from "./timeline";
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

function appendFixture(...args: Parameters<typeof appendTrackedEntry>) {
  return appendTrackedEntry(...args).status === "written";
}

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
    appendFixture(dir, createTimelineEntry({ messages: [msg("a")], provider: "claude" }), NOW);
    appendFixture(dir, createTimelineEntry({ messages: [msg("b")], provider: "claude" }), NOW);
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

describe("exact tracked row handles", () => {
  it("uses the current date when a tracked append omits now", () => {
    const dir = mkDir();
    const result = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("default now")] }));

    expect(result.status).toBe("written");
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("reports write when lock acquisition throws a non-contention error", () => {
    const dir = mkDir();
    const lock = lockPathFor(dir, filenameForDate(NOW));
    const originalMkdirSync = nodeFs.mkdirSync;
    nodeFs.mkdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
      if (String(target) === lock) {
        const error = new Error("lock parent failure") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return (originalMkdirSync as (...values: unknown[]) => unknown)(target, ...args);
    }) as typeof nodeFs.mkdirSync;
    syncBuiltinESMExports();
    try {
      expect(appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("blocked")] }), NOW))
        .toEqual({ status: "rejected", reason: "write" });
    } finally {
      nodeFs.mkdirSync = originalMkdirSync;
      syncBuiltinESMExports();
    }
  });

  it("reports write and releases the lock when append serialization throws", () => {
    const dir = mkDir();
    const entry = createTimelineEntry({ messages: [msg("circular")] }) as ReturnType<typeof createTimelineEntry> & { circular?: unknown };
    entry.circular = entry;

    expect(appendTrackedEntry(dir, entry, NOW)).toEqual({ status: "rejected", reason: "write" });
    const lock = lockPathFor(dir, filenameForDate(NOW));
    expect(acquireLock(lock)).toBe(true);
    releaseLock(lock);
  });

  it("refreshes an older handle across recorder-owned appends and updates only its captured row", () => {
    const dir = mkDir();
    const first = appendTrackedEntry(
      dir,
      createTimelineEntry({ messages: [msg("first")], sessionId: "s1", provider: "claude" }),
      NOW,
    );
    expect(first.status).toBe("written");
    if (first.status !== "written" || !first.handle) throw new Error("missing first handle");

    const second = appendTrackedEntry(
      dir,
      createTimelineEntry({ messages: [msg("second")], sessionId: "s2", provider: "codex" }),
      NOW,
    );
    expect(second.status).toBe("written");
    if (second.status !== "written") throw new Error("missing second rewrite");
    const refreshed = refreshTimelineEntryHandle(first.handle, second.rewrite);
    expect(refreshed).not.toBeNull();

    const updated = updateTrackedEntry(dir, refreshed!, (entry) => ({
      ...entry,
      agent_responses: ["response for first"],
    }));
    expect(updated.status).toBe("written");
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows.map((row) => row.agent_responses)).toEqual([["response for first"], []]);
  });

  it("rejects a stale generation without falling through to the latest row", () => {
    const dir = mkDir();
    const first = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("first")] }), NOW);
    if (first.status !== "written" || !first.handle) throw new Error("missing first handle");
    expect(appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("latest")] }), NOW).status)
      .toBe("written");

    const rejected = updateTrackedEntry(dir, first.handle, (entry) => ({
      ...entry,
      agent_responses: ["must not land"],
    }));
    expect(rejected).toEqual({ status: "rejected", reason: "generation" });
    expect(readRecentEntries(dir, { now: NOW }).map((row) => row.agent_responses)).toEqual([[], []]);
  });

  it("rejects an external rewrite even when the captured row remains at the same ordinal", () => {
    const dir = mkDir();
    const tracked = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("captured")] }), NOW);
    if (tracked.status !== "written" || !tracked.handle) throw new Error("missing tracked handle");
    expect(appendFixture(dir, createTimelineEntry({ messages: [msg("external")] }), NOW)).toBe(true);

    expect(updateTrackedEntry(dir, tracked.handle, (entry) => entry))
      .toEqual({ status: "rejected", reason: "generation" });
  });

  it("fails closed on ordinal or hash mismatch", () => {
    const dir = mkDir();
    const tracked = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("captured")] }), NOW);
    if (tracked.status !== "written" || !tracked.handle) throw new Error("missing tracked handle");
    const wrongOrdinal: TimelineEntryHandle = { ...tracked.handle, rowOrdinal: 99 };
    const wrongHash: TimelineEntryHandle = { ...tracked.handle, expectedHash: "0".repeat(64) };

    expect(updateTrackedEntry(dir, wrongOrdinal, (entry) => entry))
      .toEqual({ status: "rejected", reason: "ordinal" });
    expect(updateTrackedEntry(dir, wrongHash, (entry) => entry))
      .toEqual({ status: "rejected", reason: "hash" });
  });

  it("rejects an unsafe forged handle filename without touching outside files", () => {
    const base = mkDir();
    const dir = path.join(base, "timeline");
    fs.mkdirSync(dir);
    const outside = path.join(base, "outside.jsonl");
    fs.writeFileSync(outside, "outside unchanged\n");
    const forged: TimelineEntryHandle = {
      filename: "../outside.jsonl",
      fileGeneration: "0".repeat(64),
      rowOrdinal: 0,
      expectedHash: "0".repeat(64),
    };

    expect(updateTrackedEntry(dir, forged, (entry) => entry))
      .toEqual({ status: "rejected", reason: "unsafe" });
    expect(fs.readFileSync(outside, "utf8")).toBe("outside unchanged\n");
  });

  it("reports write, preserves bytes, and releases the lock when an update callback throws", () => {
    const dir = mkDir();
    const tracked = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("captured")] }), NOW);
    if (tracked.status !== "written" || !tracked.handle) throw new Error("missing tracked handle");
    const file = path.join(dir, tracked.handle.filename);
    const before = fs.readFileSync(file);

    expect(updateTrackedEntry(dir, tracked.handle, () => { throw new Error("update failed"); }))
      .toEqual({ status: "rejected", reason: "write" });
    expect(fs.readFileSync(file)).toEqual(before);
    const lock = lockPathFor(dir, tracked.handle.filename);
    expect(acquireLock(lock)).toBe(true);
    releaseLock(lock);
  });

  it("preserves source bytes when an exact-handle update is oversized or locked", () => {
    const dir = mkDir();
    const written = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("original")] }), NOW);
    if (written.status !== "written" || !written.handle) throw new Error("missing handle");
    const file = path.join(dir, filenameForDate(NOW));
    const bytes = fs.readFileSync(file);
    expect(updateTrackedEntry(dir, written.handle, entry => ({ ...entry, agent_responses: ["界".repeat(TIMELINE_MAX_BYTES)] })))
      .toEqual({ status: "rejected", reason: "oversized" });
    expect(fs.readFileSync(file)).toEqual(bytes);
    const lock = lockPathFor(dir, filenameForDate(NOW));
    expect(acquireLock(lock)).toBe(true);
    try {
      expect(updateTrackedEntry(dir, written.handle, entry => ({ ...entry, agent_responses: ["blocked"] })))
        .toEqual({ status: "rejected", reason: "lock" });
      expect(fs.readFileSync(file)).toEqual(bytes);
    } finally { releaseLock(lock); }
  });

  it("fences a handle when compaction evicts its row", () => {
    const dir = mkDir();
    const first = appendTrackedEntry(dir, entryWithPayloadBytes(240_000, "old"), NOW);
    if (first.status !== "written" || !first.handle) throw new Error("missing first handle");
    let handle: TimelineEntryHandle | null = first.handle;
    for (let index = 0; index < 6 && handle; index++) {
      const write = appendTrackedEntry(dir, entryWithPayloadBytes(240_000, `new-${index}`), NOW);
      if (write.status !== "written") throw new Error("append failed");
      handle = refreshTimelineEntryHandle(handle, write.rewrite);
    }
    expect(handle).toBeNull();
    expect(readRecentEntries(dir, { now: NOW }).some((row) => row.session_id === "old")).toBe(false);
  });

  it("updates the captured prior-day file after midnight", () => {
    const dir = mkDir();
    const yesterday = new Date("2026-06-24T23:59:59");
    const tracked = appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("before midnight")] }), yesterday);
    if (tracked.status !== "written" || !tracked.handle) throw new Error("missing prior-day handle");
    expect(appendTrackedEntry(dir, createTimelineEntry({ messages: [msg("new day")] }), NOW).status)
      .toBe("written");

    expect(updateTrackedEntry(dir, tracked.handle, (entry) => ({ ...entry, agent_responses: ["old-day response"] })).status)
      .toBe("written");
    const rows = readRecentEntries(dir, { now: NOW });
    expect(rows.map((row) => row.agent_responses)).toEqual([["old-day response"], []]);
  });
});

describe("daily timeline hard cap", () => {
  it("evicts oldest complete rows and keeps valid ordered JSONL at or below exactly 1 MiB", () => {
    const dir = mkDir();
    for (let index = 0; index < 6; index++) {
      expect(appendFixture(dir, entryWithPayloadBytes(240_000, `s${index}`), NOW)).toBe(true);
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
    expect(appendFixture(dir, createTimelineEntry({ messages: [msg("original")] }), NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    const before = fs.readFileSync(file);
    expect(appendFixture(dir, entryWithPayloadBytes(TIMELINE_MAX_BYTES), NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("uses UTF-8 byte length at the exact cap and rejects a multibyte overflow", () => {
    const dir = mkDir();
    const exact = entryAtExactBytesWithMultibyte(TIMELINE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8") + 1).toBe(TIMELINE_MAX_BYTES);
    expect(appendFixture(dir, exact, NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    expect(fs.statSync(file).size).toBe(TIMELINE_MAX_BYTES);
    const before = fs.readFileSync(file);
    const overflow = createTimelineEntry({
      messages: [msg(`${exact.messages[0].content.text}界`)],
      sessionId: "utf8",
      provider: "claude",
    });

    expect(Buffer.byteLength(JSON.stringify(overflow), "utf8") + 1).toBe(TIMELINE_MAX_BYTES + 3);
    expect(appendFixture(dir, overflow, NOW)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(before);
  }, 30_000);

  it("rejects a newest row that fits alone but cannot coexist with the required barrier sentinel", () => {
    const dir = mkDir();
    const barrier = createSystemEntry("reset_session", "2026-06-25T12:00:00Z");
    expect(appendFixture(dir, barrier, NOW)).toBe(true);
    const file = path.join(dir, filenameForDate(NOW));
    const before = fs.readFileSync(file);
    const candidate = entryAtExactBytes(TIMELINE_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(candidate), "utf8") + 1).toBe(TIMELINE_MAX_BYTES);
    expect(appendFixture(dir, candidate, NOW)).toBe(false);
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
    expect(appendFixture(dir, createTimelineEntry({ messages: [msg("old")], sessionId: "s-old", provider: "claude" }), yesterday)).toBe(true);
    expect(appendFixture(dir, createSystemEntry("reset_session", "2026-06-25T10:00:00Z"), NOW)).toBe(true);
    for (let index = 0; index < 6; index++) {
      expect(appendFixture(dir, entryWithPayloadBytes(220_000, null, "codex"), NOW)).toBe(true);
    }
    expect(findResumableSession(readRecentEntries(dir, { maxDays: 2, now: NOW }), "claude")).toBeNull();

    expect(appendFixture(dir, createTimelineEntry({ messages: [msg("new")], sessionId: "s-new", provider: "codex" }), NOW)).toBe(true);
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
    expect(appendFixture(linkedTimeline, createTimelineEntry({ messages: [msg("blocked")] }), NOW)).toBe(false);
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

    expect(appendFixture(timelineLink, createTimelineEntry({ messages: [msg("blocked-dir-link")] }), NOW)).toBe(false);
    expect(fs.readFileSync(outsideTimelineFile)).toEqual(beforeTimelineTarget);

    const realTimeline = path.join(base, "real-timeline");
    fs.mkdirSync(realTimeline);
    const outsideDailyTarget = path.join(outside, "daily-target.jsonl");
    fs.writeFileSync(outsideDailyTarget, "outside daily unchanged\n");
    fs.symlinkSync(outsideDailyTarget, path.join(realTimeline, filename));
    const beforeDailyTarget = fs.readFileSync(outsideDailyTarget);

    expect(appendFixture(realTimeline, createTimelineEntry({ messages: [msg("blocked-file-link")] }), NOW)).toBe(false);
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
    expect(appendFixture(
      dir,
      createTimelineEntry({ messages: [msg("first")], sessionId: "s1", provider: "claude" }),
      NOW,
    )).toBe(true);

    expect(appendFixture(
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

    expect(appendFixture(dir, createTimelineEntry({ messages: [msg("latest")], sessionId: "latest" }), NOW)).toBe(true);
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

  it("returns the exact backend session fenced by a stall_recovery barrier", () => {
    const rows = [
      { ...createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-poison" }) },
      createSystemEntry("stall_recovery", "2026-06-25T12:00:00Z", "sess-poison"),
    ];
    expect(resolveResumableSession(rows, "codex")).toEqual({
      kind: "barrier",
      type: "stall_recovery",
      forgottenSessionId: "sess-poison",
      fencedSessionId: "sess-poison",
    });
    expect(findResumableSession(rows, "codex")).toBeNull();
  });

  it("carries an un-cleared first-stall attempt across later rows for the same session", () => {
    const rows = [
      createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-poison" }),
      createSystemEntry("stall_recovery_attempt", "2026-06-25T12:00:00Z", "sess-poison"),
      createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-poison" }),
    ];
    expect(resolveResumableSession(rows, "codex")).toEqual({
      kind: "session",
      sessionId: "sess-poison",
      stalledSessionId: "sess-poison",
      fencedSessionId: null,
    });
  });

  it("retains the consumed attempt even when no timeline session row remains", () => {
    const rows = [
      createSystemEntry("stall_recovery_attempt", "2026-06-25T12:00:00Z", "sess-poison"),
    ];
    expect(resolveResumableSession(rows, "codex")).toEqual({
      kind: "none",
      stalledSessionId: "sess-poison",
      fencedSessionId: null,
    });
  });

  it("a clean-completion marker clears the durable first-stall attempt", () => {
    const rows = [
      createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-poison" }),
      createSystemEntry("stall_recovery_attempt", "2026-06-25T12:00:00Z", "sess-poison"),
      createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-poison" }),
      createSystemEntry("stall_recovery_clear", "2026-06-25T12:01:00Z", "sess-poison"),
    ];
    expect(resolveResumableSession(rows, "codex")).toEqual({
      kind: "session",
      sessionId: "sess-poison",
      stalledSessionId: null,
      fencedSessionId: null,
    });
  });

  it("carries an exact fence alongside a newer healthy session", () => {
    const rows = [
      createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-poison" }),
      createSystemEntry("stall_recovery", "2026-06-25T12:00:00Z", "sess-poison"),
      createTimelineEntry({ messages: [], provider: "codex", sessionId: "sess-healthy" }),
    ];
    expect(resolveResumableSession(rows, "codex")).toEqual({
      kind: "session",
      sessionId: "sess-healthy",
      stalledSessionId: null,
      fencedSessionId: "sess-poison",
    });
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
