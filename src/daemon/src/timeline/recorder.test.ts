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

describe("forgetSession — inline system row", () => {
  it("appends a bare reset_session system row (no forgot_session_id) and clears the map", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("agent_1", "sess-1");

    rec.forgetSession("agent_1");
    const rows = readRecentEntries(dir, { now: NOW() });
    const last = rows[rows.length - 1];
    expect(last.system?.type).toBe("reset_session");
    expect((last.system as unknown as { forgot_session_id?: unknown }).forgot_session_id).toBeUndefined();
    expect(last.session_id).toBeNull();
    expect(last.messages).toEqual([]);
    expect(last.agent_responses).toEqual([]);

    // A subsequent append proves the in-memory session id was cleared —
    // the new turn row carries null for session_id.
    rec.appendEntryForAgent("agent_1", [msg("#1", "post-reset")]);
    const afterRows = readRecentEntries(dir, { now: NOW() });
    expect(afterRows[afterRows.length - 1].session_id).toBeNull();
  });

  it("writes a valid reset_session row on a fresh workdir with no in-memory session and no prior rows", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });

    rec.forgetSession("agent_1");
    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(1);
    expect(rows[0].system?.type).toBe("reset_session");
  });
});

describe("appendResponseToLatest — text-before-first-pull fallback", () => {
  it("after a reset barrier, a text event before the first inbox pull opens a fresh turn row (does NOT clobber the barrier)", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });

    rec.setSession("a", "sess-1");
    rec.appendEntryForAgent("a", [msg("#1", "hi")]);
    rec.appendResponseToLatest("a", "old reply");

    // Owner-triggered reset — barrier is the newest line now.
    rec.forgetSession("a");

    // Fresh spawn: session_init lands, then a text event BEFORE the agent
    // pulls its inbox.
    rec.setSession("a", "sess-2");
    rec.appendResponseToLatest("a", "I'll check for unfinished work.");

    const rows = readRecentEntries(dir, { now: NOW() });
    // Row 0: original turn — untouched.
    expect(rows[0].messages.map((m) => m.content.text)).toEqual(["hi"]);
    expect(rows[0].agent_responses).toEqual(["old reply"]);
    // Row 1: the barrier — MUST NOT carry the response.
    expect(rows[1].system?.type).toBe("reset_session");
    expect(rows[1].agent_responses).toEqual([]);
    // Row 2: the fallback turn row, opened by appendResponseToLatest.
    expect(rows[2].system).toBeUndefined();
    expect(rows[2].session_id).toBe("sess-2");
    expect(rows[2].provider).toBe("claude");
    expect(rows[2].messages).toEqual([]);
    expect(rows[2].agent_responses).toEqual(["I'll check for unfinished work."]);
  });

  it("subsequent inbox pull appends its OWN turn row (fallback row has a response, so appendOrMergeEntry won't merge)", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });

    rec.forgetSession("a"); // barrier
    rec.setSession("a", "sess-2");
    rec.appendResponseToLatest("a", "pre-pull chatter");
    // Now the fresh spawn actually pulls inbox.
    rec.appendEntryForAgent("a", [msg("#1", "unread")]);
    rec.appendResponseToLatest("a", "post-pull reply");

    const rows = readRecentEntries(dir, { now: NOW() });
    // [barrier, fallback, pull]
    expect(rows).toHaveLength(3);
    expect(rows[0].system?.type).toBe("reset_session");
    expect(rows[1].agent_responses).toEqual(["pre-pull chatter"]);
    expect(rows[1].messages).toEqual([]);
    expect(rows[2].messages.map((m) => m.content.text)).toEqual(["unread"]);
    expect(rows[2].agent_responses).toEqual(["post-pull reply"]);
  });

  it("first-ever text event with no prior rows opens a fallback turn row", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });

    rec.setSession("a", "sess-1");
    rec.appendResponseToLatest("a", "hello");

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess-1");
    expect(rows[0].agent_responses).toEqual(["hello"]);
    expect(rows[0].messages).toEqual([]);
  });
});

describe("resumeSessionId honors the reset_session barrier", () => {
  it("multi-turn survival: three rows all carrying sess-1 then reset → null", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("a", "sess-1");
    rec.appendEntryForAgent("a", [msg("#1", "t1")]);
    rec.appendResponseToLatest("a", "r1");
    rec.appendEntryForAgent("a", [msg("#2", "t2")]);
    rec.appendResponseToLatest("a", "r2");
    rec.appendEntryForAgent("a", [msg("#3", "t3")]);
    rec.appendResponseToLatest("a", "r3");
    rec.forgetSession("a");

    expect(rec.resumeSessionId("a", "claude")).toBeNull();
  });

  it("future sessions unaffected: reset + newer row carrying sess-2 → returns sess-2", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("a", "sess-1");
    rec.appendEntryForAgent("a", [msg("#1", "old")]);
    rec.appendResponseToLatest("a", "reply1");
    rec.forgetSession("a");
    rec.setSession("a", "sess-2");
    rec.appendEntryForAgent("a", [msg("#2", "fresh")]);

    expect(rec.resumeSessionId("a", "claude")).toBe("sess-2");
  });

  it("no reset → unchanged behavior (returns newest non-null session_id)", () => {
    const dir = mkDir();
    const rec = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    rec.setSession("a", "sess-only");
    rec.appendEntryForAgent("a", [msg("#1", "x")]);

    expect(rec.resumeSessionId("a", "claude")).toBe("sess-only");
  });
});
