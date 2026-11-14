import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import fsModule from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { appendMemoryCommit, validateMemoryCommit, MEMORY_COMMITS_FILE_MAX_BYTES } from "./commit.js";
import { createTimelineRecorder } from "../timeline/recorder.js";
import { readRecentEntries, resolveResumableSession } from "../timeline/timeline.js";

const dirs: string[] = [];
function workspace() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-commit-")); dirs.push(dir); return dir; }
const commitTime = new Date("2026-11-13T12:00:00Z");
function recordLine(no: number, log: string) { return JSON.stringify({ no, time: commitTime.toISOString(), log, reset: false }) + "\n"; }
function oversizedHistory(logBytes = 10240) { return Array.from({ length: 20 }, (_, no) => recordLine(no, "\u0001".repeat(logBytes))); }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("memory commit append contract", () => {
  it("starts at zero, increments the preceding no and never changes the earlier bytes", () => {
    const dir = workspace();
    const first = appendMemoryCommit(dir, { log: "  I corrected memory.\nNext: verify 🎉.\n", reset: false }, new Date("2026-11-13T12:00:00Z"));
    const before = fs.readFileSync(path.join(dir, ".commits.jsonl"));
    const second = appendMemoryCommit(dir, { log: "I checked the remaining source.", reset: true });
    const after = fs.readFileSync(path.join(dir, ".commits.jsonl"));
    expect(after.subarray(0, before.length)).toEqual(before);
    expect(first).toEqual({ no: 0, time: "2026-11-13T12:00:00.000Z", log: "  I corrected memory.\nNext: verify 🎉.\n", reset: false });
    expect(second.no).toBe(1);
    expect(after.toString().trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([first, second]);
    fs.writeFileSync(path.join(dir, ".commits.jsonl"), JSON.stringify({ ...second, no: 42 }) + "\n");
    expect(appendMemoryCommit(dir, { log: "I continued.", reset: false }).no).toBe(43);
  });
  it("counts UTF-8 log bytes, not JSON escapes or code units", () => {
    const dir = workspace();
    expect(appendMemoryCommit(dir, { log: "🎉".repeat(2560), reset: false }).no).toBe(0);
    expect(appendMemoryCommit(dir, { log: "\n".repeat(10239) + "a", reset: false }).no).toBe(1);
    const before = fs.readFileSync(path.join(dir, ".commits.jsonl"));
    expect(() => appendMemoryCommit(dir, { log: "🎉".repeat(2560) + "a", reset: true })).toThrow("10 KiB");
    expect(fs.readFileSync(path.join(dir, ".commits.jsonl"))).toEqual(before);
  });
  it("allows exactly 1 MiB, then removes only the oldest complete record when the next commit crosses it", () => {
    const dir = workspace(); const file = path.join(dir, ".commits.jsonl");
    const prefix = Array.from({ length: 101 }, (_, no) => recordLine(no, "🎉".repeat(2560))).join("");
    const next = recordLine(102, "next");
    const padding = MEMORY_COMMITS_FILE_MAX_BYTES - Buffer.byteLength(prefix + recordLine(101, "") + next);
    expect(padding).toBeGreaterThan(0);
    expect(padding).toBeLessThanOrEqual(10240);
    const before = prefix + recordLine(101, "x".repeat(padding));
    fs.writeFileSync(file, before);
    expect(appendMemoryCommit(dir, { log: "next", reset: false }, commitTime).no).toBe(102);
    const full = fs.readFileSync(file);
    expect(full.length).toBe(1048576);
    expect(full).toEqual(Buffer.from(before + next));
    expect(appendMemoryCommit(dir, { log: "after boundary", reset: false }, commitTime).no).toBe(103);
    const retained = fs.readFileSync(file);
    expect(retained).toEqual(Buffer.concat([full.subarray(full.indexOf(10) + 1), Buffer.from(recordLine(103, "after boundary"))]));
    expect(retained.length).toBeLessThanOrEqual(1048576);
    expect(JSON.parse(retained.toString().split("\n")[0]).no).toBe(1);
  });
  it.each([10240, 24576])("caps oversized history with %i-byte logs, preserves the newest suffix and continues numbering", (logBytes) => {
    const dir = workspace(); const file = path.join(dir, ".commits.jsonl");
    const original = oversizedHistory(logBytes);
    fs.writeFileSync(file, original.join(""));
    expect(fs.statSync(file).size).toBeGreaterThan(1048576);
    const next = recordLine(20, "Core change 🎉");
    const expected = [...original];
    while (Buffer.byteLength(expected.join("") + next) > 1048576) expected.shift();
    const lastRemoved = original[original.length - expected.length - 1];
    expect(Buffer.byteLength(lastRemoved + expected.join("") + next)).toBeGreaterThan(1048576);
    expect(appendMemoryCommit(dir, { log: "Core change 🎉", reset: false }, commitTime).no).toBe(20);
    const actual = fs.readFileSync(file);
    expect(actual).toEqual(Buffer.from(expected.join("") + next));
    expect(actual.length).toBeLessThanOrEqual(1048576);
    expect(actual.toString().trimEnd().split("\n").map((line) => JSON.parse(line).no)).toEqual(Array.from({ length: expected.length + 1 }, (_, n) => original.length - expected.length + n));
    expect(appendMemoryCommit(dir, { log: "Next core change", reset: false }, commitTime).no).toBe(21);
  });
  it.each(["writeFileSync", "fsyncSync", "renameSync"] as const)("preserves previous history and removes temporary files when retention %s fails", (operation) => {
    const dir = workspace(); const file = path.join(dir, ".commits.jsonl");
    const before = oversizedHistory().join("");
    fs.writeFileSync(file, before);
    const failure = vi.spyOn(fsModule, operation).mockImplementation(() => { throw new Error("disk failure"); });
    syncBuiltinESMExports();
    try {
      expect(() => appendMemoryCommit(dir, { log: "Core change", reset: true }, commitTime)).toThrow("disk failure");
    } finally { failure.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual([".commits.jsonl"]);
  });
  it("rejects a damaged oversized history without deleting older records", () => {
    const dir = workspace(); const file = path.join(dir, ".commits.jsonl");
    const before = oversizedHistory().join("") + "{";
    fs.writeFileSync(file, before);
    expect(() => appendMemoryCommit(dir, { log: "Core change", reset: true }, commitTime)).toThrow("incomplete last record");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it.each([{}, { log: " " }, { log: "ok", reset: "false" }, { log: "ok", reset: false, agentId: "other" }])("rejects invalid input: %j", (value) => {
    expect(() => validateMemoryCommit(value)).toThrow();
  });
  it.each(["{", '{"no":0}\n', '{"no":0,"time":"now","log":"ok","reset":true}'])("rejects damaged tails without rewriting them: %s", (tail) => {
    const dir = workspace(); const file = path.join(dir, ".commits.jsonl");
    fs.writeFileSync(file, tail);
    expect(() => appendMemoryCommit(dir, { log: "I reviewed.", reset: true })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(tail);
  });
  it("rejects a symlink or directory instead of writing elsewhere", () => {
    const dir = workspace(); const other = workspace(); const target = path.join(other, "private.txt");
    fs.writeFileSync(target, "unchanged");
    fs.symlinkSync(target, path.join(dir, ".commits.jsonl"));
    expect(() => appendMemoryCommit(dir, { log: "I reviewed.", reset: true })).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
    fs.unlinkSync(path.join(dir, ".commits.jsonl")); fs.mkdirSync(path.join(dir, ".commits.jsonl"));
    expect(() => appendMemoryCommit(dir, { log: "I reviewed.", reset: true })).toThrow();
  });
  it("writes a nonbarrier commit event, then an independent reset event", () => {
    const dir = workspace(); const timelineDir = path.join(dir, ".context_timeline");
    const recorder = createTimelineRecorder({ timelineDirFor: () => timelineDir });
    expect(recorder.setSession("bot", "old-session", "epoch")).toBe(true);
    const generation = recorder.barrierGeneration("bot");
    const owner = { sessionInstanceId: "epoch", rootTurnId: "turn", barrierGeneration: generation };
    recorder.beginTurn("bot", owner);
    recorder.recordAssistantMessage("bot", owner, "I reviewed the sources.");
    recorder.finalizeTurn("bot", owner);
    expect(recorder.recordCommit("bot", 7)).toBe(true);
    let rows = readRecentEntries(timelineDir);
    expect(rows.at(-1)?.system).toMatchObject({ type: "commit", no: 7 });
    expect(resolveResumableSession(rows).kind).toBe("session");
    expect(recorder.barrierGeneration("bot")).toBe(generation);
    expect(recorder.resumeSessionId("bot", null)).toBe("old-session");
    expect(recorder.forgetSession("bot")).toBe(true);
    rows = readRecentEntries(timelineDir);
    expect(rows.slice(-2).map((entry) => entry.system?.type)).toEqual(["commit", "reset_session"]);
    expect(recorder.resumeSessionId("bot", null)).toBeNull();
  });
});
