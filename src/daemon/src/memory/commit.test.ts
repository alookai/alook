import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendMemoryCommit, validateMemoryCommit } from "./commit.js";
import { createTimelineRecorder } from "../timeline/recorder.js";
import { readRecentEntries, resolveResumableSession } from "../timeline/timeline.js";

const dirs: string[] = [];
function workspace() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-commit-")); dirs.push(dir); return dir; }
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
    expect(appendMemoryCommit(dir, { log: "🎉".repeat(6144), reset: false }).no).toBe(0);
    expect(appendMemoryCommit(dir, { log: "\n".repeat(24575) + "a", reset: false }).no).toBe(1);
    const before = fs.readFileSync(path.join(dir, ".commits.jsonl"));
    expect(() => appendMemoryCommit(dir, { log: "🎉".repeat(6144) + "a", reset: true })).toThrow("24 KiB");
    expect(fs.readFileSync(path.join(dir, ".commits.jsonl"))).toEqual(before);
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
