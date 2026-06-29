import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createTimelineRecorder } from "./recorder";
import { readRecentEntries } from "./timeline";
import type { Message } from "../server/contract";

const tmpDirs: string[] = [];
function mkDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const NOW = () => new Date("2026-06-25T12:00:00");
const msg = (seq: string, text: string): Message => ({
  seq,
  channel: "/srv/general",
  sender: "@gustavo",
  content: { text },
  time: "2026-06-25T12:00:00+00:00",
});

describe("createTimelineRecorder (append-only, 4-field schema)", () => {
  it("bakes the session id (set before the pull) into the opened entry, then accumulates responses", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });

    // session_init lands first (control plane), then the agent pulls (data plane).
    rec.setSession("agent_1", "sess-42");
    rec.appendEntryForAgent("agent_1", [msg("#1", "hello team")]);
    rec.appendResponseToLatest("agent_1", "thinking…");
    rec.appendResponseToLatest("agent_1", "hi!");

    const [row] = readRecentEntries(dir, { now: NOW() });
    expect(row.messages.map((m) => m.content.text)).toEqual(["hello team"]);
    expect(row.session_id).toBe("sess-42");
    expect(row.provider).toBe("claude");
    expect(row.agent_responses).toEqual(["thinking…", "hi!"]);
  });

  it("a pull AFTER the latest row already has a response opens a new entry", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });

    rec.appendEntryForAgent("agent_1", [msg("#1", "first")]);
    rec.appendResponseToLatest("agent_1", "reply to first");
    rec.appendEntryForAgent("agent_1", [msg("#2", "second")]); // latest had a response → new entry
    rec.appendResponseToLatest("agent_1", "reply to second");

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].messages[0].content.text).toBe("first");
    expect(rows[0].agent_responses).toEqual(["reply to first"]);
    expect(rows[1].messages[0].content.text).toBe("second");
    expect(rows[1].agent_responses).toEqual(["reply to second"]);
  });

  it("consecutive pulls with NO response between merge into one entry (same session/provider)", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("agent_1", "sess-1");

    rec.appendEntryForAgent("agent_1", [msg("#1", "first")]);
    rec.appendEntryForAgent("agent_1", [msg("#2", "second")]); // no response yet → merge
    rec.appendResponseToLatest("agent_1", "reply to both");

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(1);
    expect(rows[0].messages.map((m) => m.content.text)).toEqual(["first", "second"]);
    expect(rows[0].agent_responses).toEqual(["reply to both"]);
  });

  it("does NOT merge when session_id differs (new session = new entry)", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("agent_1", "sess-1");
    rec.appendEntryForAgent("agent_1", [msg("#1", "first")]);
    rec.setSession("agent_1", "sess-2");
    rec.appendEntryForAgent("agent_1", [msg("#2", "second")]);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].session_id).toBe("sess-1");
    expect(rows[1].session_id).toBe("sess-2");
  });

  it("resumeSessionId returns the latest session id for the agent", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });

    rec.setSession("agent_1", "sess-old");
    rec.appendEntryForAgent("agent_1", [msg("#1", "a")]);
    expect(rec.resumeSessionId("agent_1", "claude")).toBe("sess-old");

    rec.setSession("agent_1", "sess-new");
    rec.appendEntryForAgent("agent_1", [msg("#2", "b")]);
    expect(rec.resumeSessionId("agent_1", "claude")).toBe("sess-new");
  });

  it("does not resume across providers", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("a", "sess-claude");
    rec.appendEntryForAgent("a", [msg("#1", "x")]);
    expect(rec.resumeSessionId("a", "codex")).toBeNull();
    expect(rec.resumeSessionId("a", "claude")).toBe("sess-claude");
  });
});
