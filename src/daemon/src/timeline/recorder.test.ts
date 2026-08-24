import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "os";
import * as path from "path";
import { createTimelineRecorder } from "./recorder";
import type { TimelineRecorderLike, TimelineTurnOwner } from "./recorder";
import { createTimelineEntry, filenameForDate, readRecentEntries, TIMELINE_MAX_BYTES } from "./timeline";
import { acquireLock, lockPathFor, releaseLock } from "./filelock";
import type { Message } from "../server/contract";

const tmpDirs: string[] = [];
function mkDir(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "recorder-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const NOW = () => new Date("2026-06-25T12:00:00");
const msg = (seq: string, text: string): Message => ({
  seq,
  channel: "/srv/general",
  sender: "@gustavo",
  content: { text },
  time: "2026-06-25T12:00:00+00:00",
});

function begin(
  recorder: TimelineRecorderLike,
  turnId: string,
  sessionInstanceId = "epoch-1",
  agentId = "a",
): TimelineTurnOwner {
  const owner = {
    sessionInstanceId,
    rootTurnId: turnId,
    barrierGeneration: recorder.barrierGeneration(agentId),
  };
  recorder.beginTurn(agentId, owner);
  return owner;
}

function observe(
  recorder: TimelineRecorderLike,
  agentId: string,
  rootTurnId: string,
  messages: Message[],
): TimelineTurnOwner {
  const owner = begin(recorder, rootTurnId, `epoch-${rootTurnId}`, agentId);
  recorder.recordInboxPull(agentId, owner, messages);
  recorder.finalizeTurn(agentId, owner);
  return owner;
}

describe("createTimelineRecorder exact turn ownership", () => {
  it("keeps an empty pull as a no-op without resolving a directory", () => {
    const timelineDirFor = vi.fn(() => {
      throw new Error("must not resolve a directory for an empty pull");
    });
    const recorder = createTimelineRecorder({ timelineDirFor, now: NOW });

    expect(() => recorder.recordInboxPull("a", null, [])).not.toThrow();
    expect(timelineDirFor).not.toHaveBeenCalled();
  });

  it("records complete messages against one exact row and finalizes idempotently", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    recorder.setSession("a", "sess-1", "epoch-1");
    const owner = begin(recorder, "turn-1");
    recorder.recordInboxPull("a", owner, [msg("#1", "hello")]);
    for (let index = 1; index <= 6; index++) recorder.recordAssistantMessage("a", owner, `response-${index}`);
    recorder.finalizeTurn("a", owner);
    recorder.finalizeTurn("a", owner);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "sess-1", provider: "claude" });
    expect(rows[0].messages.map((message) => message.content.text)).toEqual(["hello"]);
    expect(rows[0].agent_responses).toEqual([
      "response-2", "response-3", "response-4", "response-5", "response-6",
    ]);
  });

  it("does not let pre-pull output from turn B mutate turn A", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const ownerA = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", ownerA, [msg("#1", "for A")]);
    recorder.recordAssistantMessage("a", ownerA, "answer A");
    recorder.finalizeTurn("a", ownerA);

    const ownerB = begin(recorder, "turn-b");
    recorder.recordAssistantMessage("a", ownerB, "opening B");
    recorder.finalizeTurn("a", ownerB);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].agent_responses).toEqual(["answer A"]);
    expect(rows[1].messages).toEqual([]);
    expect(rows[1].agent_responses).toEqual(["opening B"]);
  });

  it("binds a late pull response to captured turn A after turn B begins", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const ownerA = begin(recorder, "turn-a");
    recorder.recordAssistantMessage("a", ownerA, "answer A");
    recorder.finalizeTurn("a", ownerA);

    const ownerB = begin(recorder, "turn-b");
    recorder.recordInboxPull("a", ownerA, [msg("#1", "late observation for A")]);
    recorder.recordAssistantMessage("a", ownerB, "answer B");
    recorder.finalizeTurn("a", ownerB);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].messages.map((message) => message.content.text)).toEqual(["late observation for A"]);
    expect(rows[0].agent_responses).toEqual(["answer A"]);
    expect(rows[1].agent_responses).toEqual(["answer B"]);
  });

  it("keeps an ownerless pull unowned when a later turn starts", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    recorder.recordInboxPull("a", null, [msg("#1", "ownerless")]);
    const owner = begin(recorder, "turn-b");
    recorder.recordAssistantMessage("a", owner, "answer B");
    recorder.finalizeTurn("a", owner);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].messages.map((message) => message.content.text)).toEqual(["ownerless"]);
    expect(rows[0].agent_responses).toEqual([]);
    expect(rows[1].agent_responses).toEqual(["answer B"]);
  });

  it("refreshes a captured handle across unrelated writes and updates only its row", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "first A")]);
    recorder.recordInboxPull("a", null, [msg("#2", "unrelated newer row")]);
    recorder.recordInboxPull("a", owner, [msg("#3", "busy A")]);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].messages.map((message) => message.content.text)).toEqual(["first A", "busy A"]);
    expect(rows[1].messages.map((message) => message.content.text)).toEqual(["unrelated newer row"]);
  });

  it("commits after midnight to the prior day's captured row", () => {
    const dir = mkDir();
    let current = new Date("2026-06-25T12:00:00");
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: () => current });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "before midnight")]);

    current = new Date("2026-06-26T12:00:00");
    recorder.recordAssistantMessage("a", owner, "after midnight response");
    recorder.finalizeTurn("a", owner);

    const firstFile = path.join(dir, filenameForDate(new Date("2026-06-25T12:00:00")));
    expect(fs.readFileSync(firstFile, "utf8")).toContain("after midnight response");
    expect(fs.existsSync(path.join(dir, filenameForDate(current)))).toBe(false);
  });

  it("opens a new-day target when the same turn pulls after midnight", () => {
    const dir = mkDir();
    let current = new Date("2026-06-25T12:00:00");
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: () => current });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "day one")]);
    current = new Date("2026-06-26T12:00:00");
    recorder.recordInboxPull("a", owner, [msg("#2", "day two")]);
    recorder.recordAssistantMessage("a", owner, "day two response");
    recorder.finalizeTurn("a", owner);

    const first = fs.readFileSync(path.join(dir, filenameForDate(new Date("2026-06-25T12:00:00"))), "utf8");
    const second = fs.readFileSync(path.join(dir, filenameForDate(current)), "utf8");
    expect(first).toContain("day one");
    expect(first).not.toContain("day two response");
    expect(second).toContain("day two");
    expect(second).toContain("day two response");
  });

  it("bounds multibyte complete messages and row-fit truncation with one explicit marker", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "x".repeat(1_020_000))]);
    recorder.recordAssistantMessage("a", owner, "你".repeat(30_000));
    recorder.finalizeTurn("a", owner);

    const [row] = readRecentEntries(dir, { now: NOW() });
    expect(Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8")).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(Buffer.byteLength(row.agent_responses[0]!, "utf8")).toBeLessThanOrEqual(65_536);
    expect(row.agent_responses[0]).toMatch(/… \[truncated\]$/u);
    expect(row.agent_responses[0]!.match(/… \[truncated\]/gu)).toHaveLength(1);
  });

  it("adds one marker when row fitting truncates an otherwise unbounded response", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner = begin(recorder, "turn-row-fit");
    recorder.recordInboxPull("a", owner, [msg("#1", "x".repeat(1_040_000))]);
    recorder.recordAssistantMessage("a", owner, "r".repeat(20_000));
    recorder.finalizeTurn("a", owner);

    const [row] = readRecentEntries(dir, { now: NOW() });
    expect(Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8")).toBeLessThanOrEqual(TIMELINE_MAX_BYTES);
    expect(row.agent_responses[0]).toMatch(/… \[truncated\]$/u);
    expect(row.agent_responses[0]!.match(/… \[truncated\]/gu)).toHaveLength(1);
  });

  it("rejects an externally rewritten captured row instead of falling back to latest", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "original")]);
    recorder.recordAssistantMessage("a", owner, "must not redirect");
    const file = path.join(dir, filenameForDate(NOW()));
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("original", "external"));
    recorder.finalizeTurn("a", owner);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(1);
    expect(rows[0].messages[0].content.text).toBe("external");
    expect(rows[0].agent_responses).toEqual([]);
    expect(diagnostics).toContain("timeline_exact_write_rejected:generation");
  });

  it("fences a captured handle omitted by an external rewrite remap", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    const owner = begin(recorder, "turn-rewritten");
    recorder.recordInboxPull("a", owner, [msg("#1", "captured")]);
    recorder.recordAssistantMessage("a", owner, "must not redirect");
    const file = path.join(dir, filenameForDate(NOW()));
    fs.writeFileSync(file, `${JSON.stringify(createTimelineEntry({ messages: [msg("#9", "external")] }))}\n`);

    recorder.recordInboxPull("a", null, [msg("#10", "unrelated")]);
    recorder.finalizeTurn("a", owner);

    expect(diagnostics).toContain("timeline_handle_fenced:rewrite_remap");
    expect(readRecentEntries(dir, { now: NOW() }).flatMap((row) => row.agent_responses))
      .not.toContain("must not redirect");
  });

  it("rejects an oversized no-handle fallback before writing a row", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    expect(recorder.setSession("a", "s".repeat(TIMELINE_MAX_BYTES), "epoch-large")).toBe(true);
    const owner = begin(recorder, "turn-large", "epoch-large");
    recorder.recordAssistantMessage("a", owner, "pre-pull output");
    recorder.finalizeTurn("a", owner);

    expect(diagnostics).toContain("timeline_response_did_not_fit:oversized");
    expect(readRecentEntries(dir, { now: NOW() })).toEqual([]);
  });

  it("records a never-begun pull owner as ownerless", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner: TimelineTurnOwner = {
      sessionInstanceId: "missing-epoch",
      rootTurnId: "missing-turn",
      barrierGeneration: recorder.barrierGeneration("a"),
    };
    recorder.recordInboxPull("a", owner, [msg("#1", "never begun")]);

    const [row] = readRecentEntries(dir, { now: NOW() });
    expect(row.messages.map((message) => message.content.text)).toEqual(["never begun"]);
    expect(row.agent_responses).toEqual([]);
  });

  it("falls back to an ownerless append when the barrier changes during pull recording", () => {
    const dir = mkDir();
    let recorder!: TimelineRecorderLike;
    let nowCalls = 0;
    let reentered = false;
    const now = () => {
      nowCalls++;
      if (nowCalls === 2 && !reentered) {
        reentered = true;
        recorder.fenceSession("a");
      }
      return NOW();
    };
    recorder = createTimelineRecorder({ timelineDirFor: () => dir, now });
    const owner = begin(recorder, "turn-barrier-race");
    nowCalls = 0;

    recorder.recordInboxPull("a", owner, [msg("#1", "barrier-raced")]);

    const [row] = readRecentEntries(dir, { now: NOW() });
    expect(row.messages.map((message) => message.content.text)).toEqual(["barrier-raced"]);
    expect(row.agent_responses).toEqual([]);
  });

  it("rejects completed output delivered after finalization", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    const owner = begin(recorder, "turn-finalized");
    recorder.finalizeTurn("a", owner);
    recorder.recordAssistantMessage("a", owner, "too late");

    expect(diagnostics).toContain("timeline_completed_message_rejected:stale_owner");
    expect(readRecentEntries(dir, { now: NOW() })).toEqual([]);
  });

  it("rejects a no-handle fallback after another turn becomes active", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    const ownerA = begin(recorder, "turn-a");
    recorder.recordAssistantMessage("a", ownerA, "buffered A");
    begin(recorder, "turn-b", "epoch-b");
    recorder.finalizeTurn("a", ownerA);

    expect(diagnostics).toContain("timeline_fallback_rejected:fenced_owner");
    expect(readRecentEntries(dir, { now: NOW() })).toEqual([]);
  });
});

describe("createTimelineRecorder barriers and pending commits", () => {
  it("rejects beginTurn owners captured before a barrier advance", () => {
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => mkDir(),
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    const staleOwner: TimelineTurnOwner = {
      sessionInstanceId: "stale-epoch",
      rootTurnId: "stale-turn",
      barrierGeneration: recorder.barrierGeneration("a"),
    };
    recorder.fenceSession("a");
    recorder.beginTurn("a", staleOwner);

    expect(diagnostics).toContain("timeline_turn_begin_fenced:barrier_generation");
  });

  it("lets a retained pre-reset handle update in place before the durable barrier", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "old turn")]);
    recorder.recordAssistantMessage("a", owner, "completed before reset");
    recorder.forgetSession("a");
    recorder.finalizeTurn("a", owner);

    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(2);
    expect(rows[0].agent_responses).toEqual(["completed before reset"]);
    expect(rows[1].system?.type).toBe("reset_session");
  });

  it("drops an old no-handle fallback across reset and model replacement fences", () => {
    for (const fence of ["reset", "model"] as const) {
      const dir = mkDir();
      const diagnostics: string[] = [];
      const recorder = createTimelineRecorder({
        timelineDirFor: () => dir,
        now: NOW,
        onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
      });
      const owner = begin(recorder, `turn-${fence}`);
      recorder.recordAssistantMessage("a", owner, "must be dropped");
      if (fence === "reset") recorder.forgetSession("a");
      else recorder.fenceSession("a");
      recorder.finalizeTurn("a", owner);

      const rows = readRecentEntries(dir, { now: NOW() });
      expect(rows.flatMap((row) => row.agent_responses)).not.toContain("must be dropped");
      expect(diagnostics.some((entry) => entry.includes("timeline_fallback_rejected"))).toBe(true);
    }
  });

  it("retains a lock-missed exact commit and retries only on later recorder activity", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    recorder.setSession("a", "sess-1", "epoch-1");
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "hello")]);
    recorder.recordAssistantMessage("a", owner, "pending response");
    const lock = lockPathFor(dir, filenameForDate(NOW()));
    expect(acquireLock(lock)).toBe(true);
    try {
      recorder.finalizeTurn("a", owner);
    } finally {
      releaseLock(lock);
    }

    expect(recorder.resumeSessionId("a", "claude")).toBe("sess-1");
    expect(readRecentEntries(dir, { now: NOW() })[0].agent_responses).toEqual([]);
    begin(recorder, "turn-b", "epoch-2");
    expect(readRecentEntries(dir, { now: NOW() })[0].agent_responses).toEqual(["pending response"]);
  });

  it("retains an authorized pre-pull fallback commit when the next turn begins", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner = begin(recorder, "turn-a");
    recorder.recordAssistantMessage("a", owner, "pending fallback");
    const lock = lockPathFor(dir, filenameForDate(NOW()));
    expect(acquireLock(lock)).toBe(true);
    try {
      recorder.finalizeTurn("a", owner);
    } finally {
      releaseLock(lock);
    }

    begin(recorder, "turn-b", "epoch-2");
    const rows = readRecentEntries(dir, { now: NOW() });
    expect(rows).toHaveLength(1);
    expect(rows[0].messages).toEqual([]);
    expect(rows[0].agent_responses).toEqual(["pending fallback"]);
  });

  it("retains a write-failed exact commit and retries after later real activity", () => {
    if (process.platform === "win32") return;
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: NOW });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "hello")]);
    recorder.recordAssistantMessage("a", owner, "write retry");
    fs.chmodSync(dir, 0o500);
    try {
      recorder.finalizeTurn("a", owner);
    } finally {
      fs.chmodSync(dir, 0o700);
    }

    expect(readRecentEntries(dir, { now: NOW() })[0].agent_responses).toEqual([]);
    begin(recorder, "turn-b", "epoch-2");
    expect(readRecentEntries(dir, { now: NOW() })[0].agent_responses).toEqual(["write retry"]);
  });

  it("expires a pending commit after 15 minutes and never redirects it", () => {
    const dir = mkDir();
    let current = new Date("2026-06-25T12:00:00");
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: () => current,
      onDiagnostic: (event) => diagnostics.push(event.code),
    });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "hello")]);
    recorder.recordAssistantMessage("a", owner, "expired response");
    const lock = lockPathFor(dir, filenameForDate(current));
    expect(acquireLock(lock)).toBe(true);
    try {
      recorder.finalizeTurn("a", owner);
    } finally {
      releaseLock(lock);
    }
    current = new Date(current.getTime() + 15 * 60_000 + 1);
    recorder.setSession("a", "new-session", "epoch-2");

    expect(readRecentEntries(dir, { now: current })[0].agent_responses).toEqual([]);
    expect(diagnostics).toContain("timeline_pending_commit_expired");
  });

  it("removes a successful finalized state after the retention TTL", () => {
    const dir = mkDir();
    let current = new Date("2026-06-25T12:00:00");
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: () => current });
    const owner = begin(recorder, "turn-reusable");
    recorder.finalizeTurn("a", owner);

    current = new Date(current.getTime() + 15 * 60_000 + 1);
    recorder.beginTurn("a", owner);
    recorder.recordAssistantMessage("a", owner, "recreated after ttl");
    recorder.finalizeTurn("a", owner);

    expect(readRecentEntries(dir, { now: current }).flatMap((row) => row.agent_responses))
      .toEqual(["recreated after ttl"]);
  });

  it("deletes a pending exact commit when its row becomes terminally stale", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(`${event.code}:${event.reason ?? ""}`),
    });
    const owner = begin(recorder, "turn-pending-terminal");
    recorder.recordInboxPull("a", owner, [msg("#1", "captured")]);
    recorder.recordAssistantMessage("a", owner, "must not redirect");
    const filename = filenameForDate(NOW());
    const file = path.join(dir, filename);
    const lock = lockPathFor(dir, filename);
    expect(acquireLock(lock)).toBe(true);
    try {
      recorder.finalizeTurn("a", owner);
    } finally {
      releaseLock(lock);
    }
    fs.writeFileSync(file, `${JSON.stringify(createTimelineEntry({ messages: [msg("#2", "replacement")] }))}\n`);

    begin(recorder, "turn-trigger", "epoch-trigger");

    expect(diagnostics).toContain("timeline_exact_write_rejected:generation");
    expect(readRecentEntries(dir, { now: NOW() }).flatMap((row) => row.agent_responses))
      .not.toContain("must not redirect");
  });

  it("prunes the oldest of more than eight retained finalized states", () => {
    const dir = mkDir();
    let current = new Date("2026-06-25T12:00:00");
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, now: () => current });
    const owners: TimelineTurnOwner[] = [];
    for (let index = 0; index < 9; index++) {
      const owner = begin(recorder, `turn-${index}`, `epoch-${index}`);
      owners.push(owner);
      recorder.finalizeTurn("a", owner);
      current = new Date(current.getTime() + 1);
    }
    begin(recorder, "turn-trigger", "epoch-trigger");

    recorder.beginTurn("a", owners[0]!);
    recorder.recordAssistantMessage("a", owners[0]!, "oldest recreated");
    recorder.finalizeTurn("a", owners[0]!);

    expect(readRecentEntries(dir, { now: current }).flatMap((row) => row.agent_responses))
      .toEqual(["oldest recreated"]);
  });

  it("bounds pending exact commits to eight per agent", () => {
    const dir = mkDir();
    const diagnostics: string[] = [];
    const recorder = createTimelineRecorder({
      timelineDirFor: () => dir,
      now: NOW,
      onDiagnostic: (event) => diagnostics.push(event.code),
    });
    const owners: TimelineTurnOwner[] = [];
    for (let index = 1; index <= 9; index++) {
      const owner = begin(recorder, `turn-${index}`, `epoch-${index}`);
      recorder.recordInboxPull("a", owner, [msg(`#${index}`, `message-${index}`)]);
      owners.push(owner);
    }
    const lock = lockPathFor(dir, filenameForDate(NOW()));
    expect(acquireLock(lock)).toBe(true);
    try {
      for (const [index, owner] of owners.entries()) {
        recorder.recordAssistantMessage("a", owner, `response-${index + 1}`);
        recorder.finalizeTurn("a", owner);
      }
    } finally {
      releaseLock(lock);
    }

    expect(diagnostics).toContain("timeline_pending_commit_overflow");
    expect(readRecentEntries(dir, { now: NOW() }).flatMap((row) => row.agent_responses)).toEqual([]);
  });
});

describe("createTimelineRecorder durable resume control", () => {
  it("resolves only the latest provider-compatible exact turn", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    expect(recorder.setSession("a", "sess-old", "epoch-old")).toBe(true);
    observe(recorder, "a", "old", [msg("#1", "old")]);
    expect(recorder.setSession("a", "sess-new", "epoch-new")).toBe(true);
    observe(recorder, "a", "new", [msg("#2", "new")]);

    expect(recorder.resumeSessionId("a", "claude")).toBe("sess-new");
    expect(recorder.resumeSessionId("a", "codex")).toBeNull();
  });

  it("keeps resume resolution at a fixed open-file bound with 1,000 historical day files", () => {
    const dir = mkDir();
    const emptyTurn = `${JSON.stringify(createTimelineEntry({ messages: [] }))}\n`;
    const historicalStart = new Date("2000-01-01T12:00:00Z");
    for (let index = 0; index < 1_000; index++) {
      const day = new Date(historicalStart);
      day.setUTCDate(day.getUTCDate() + index);
      fs.writeFileSync(path.join(dir, filenameForDate(day)), emptyTurn);
    }
    for (let index = 0; index < 7; index++) {
      const day = new Date(NOW());
      day.setDate(day.getDate() - index);
      fs.writeFileSync(path.join(dir, filenameForDate(day)), emptyTurn);
    }
    fs.writeFileSync(path.join(dir, ".resume-control.json"), `${JSON.stringify({
      version: 1,
      attemptedSessionId: null,
      fencedSessionId: null,
      fullBarrier: null,
    })}\n`);

    const originalOpenSync = nodeFs.openSync;
    const open = vi.fn(originalOpenSync);
    nodeFs.openSync = open as typeof nodeFs.openSync;
    syncBuiltinESMExports();
    try {
      const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "codex", now: NOW });
      expect(recorder.resolveResumeSession("a", "codex")).toEqual({
        kind: "none",
        stalledSessionId: null,
        fencedSessionId: null,
      });
      expect(open).toHaveBeenCalledTimes(8);
    } finally {
      nodeFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
    }
  }, 30_000);

  it("uses history only when control is missing and fails closed for corrupt control", () => {
    const makeHistory = (): { dir: string; control: string } => {
      const dir = mkDir();
      const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "codex", now: NOW });
      recorder.setSession("a", "sess-existing", "epoch-existing");
      observe(recorder, "a", "existing", [msg("#1", "existing")]);
      return { dir, control: path.join(dir, ".resume-control.json") };
    };
    const resolve = (dir: string) => createTimelineRecorder({
      timelineDirFor: () => dir,
      providerFor: () => "codex",
      now: NOW,
    }).resolveResumeSession("a", "codex");

    const missing = makeHistory();
    fs.unlinkSync(missing.control);
    expect(resolve(missing.dir)).toMatchObject({ kind: "session", sessionId: "sess-existing" });

    for (const body of ["{not-json}\n", "x".repeat(4_097)]) {
      const corrupt = makeHistory();
      fs.writeFileSync(corrupt.control, body);
      expect(resolve(corrupt.dir)).toEqual({
        kind: "barrier",
        type: "reset_session",
        forgottenSessionId: null,
        fencedSessionId: null,
      });
    }
  });

  it("persists and clears the one-stall recovery allowance", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "codex", now: NOW });
    recorder.setSession("a", "sess-poison", "epoch-poison");
    observe(recorder, "a", "before-stall", [msg("#1", "before stall")]);

    expect(recorder.recordSessionStall("a", "sess-poison")).toBe(true);
    expect(recorder.resolveResumeSession("a", "codex")).toMatchObject({
      kind: "session",
      sessionId: "sess-poison",
      stalledSessionId: "sess-poison",
    });
    expect(recorder.clearSessionStall("a", "sess-poison")).toBe(true);
    expect(recorder.resolveResumeSession("a", "codex")).toMatchObject({
      kind: "session",
      sessionId: "sess-poison",
      stalledSessionId: null,
    });
  });

  for (const failureMode of ["lock", "rename"] as const) {
    for (const transition of ["attempt", "fence", "reset_session", "nap", "clear"] as const) {
      it(`does not advance ${transition} when the control ${failureMode} transition fails`, () => {
        const dir = mkDir();
        const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "codex", now: NOW });
        expect(recorder.setSession("a", "sess-poison", "epoch-poison")).toBe(true);
        observe(recorder, "a", "before-transition", [msg("#1", "before transition")]);
        if (transition === "fence" || transition === "clear") {
          expect(recorder.recordSessionStall("a", "sess-poison")).toBe(true);
        }

        const controlPath = path.join(dir, ".resume-control.json");
        const beforeControl = fs.readFileSync(controlPath, "utf8");
        const beforeSystems = readRecentEntries(dir, { now: NOW() }).filter((row) => row.system).map((row) => row.system);
        const lockPath = lockPathFor(dir, ".resume-control.json");
        const originalRenameSync = nodeFs.renameSync;
        if (failureMode === "lock") expect(acquireLock(lockPath)).toBe(true);
        else {
          nodeFs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
            if (String(newPath) === controlPath) throw new Error("injected control rename failure");
            return originalRenameSync(oldPath, newPath);
          }) as typeof nodeFs.renameSync;
          syncBuiltinESMExports();
        }
        try {
          const result = transition === "attempt"
            ? recorder.recordSessionStall("a", "sess-poison")
            : transition === "fence"
              ? recorder.forgetSession("a", "stall_recovery", "sess-poison")
              : transition === "clear"
                ? recorder.clearSessionStall("a", "sess-poison")
                : recorder.forgetSession("a", transition);
          expect(result).toBe(false);
        } finally {
          if (failureMode === "lock") releaseLock(lockPath);
          else {
            nodeFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
          }
        }

        expect(fs.readFileSync(controlPath, "utf8")).toBe(beforeControl);
        expect(readRecentEntries(dir, { now: NOW() }).filter((row) => row.system).map((row) => row.system))
          .toEqual(beforeSystems);
      });
    }
  }

  it("keeps the prior in-memory session when setSession cannot persist", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "codex", now: NOW });
    expect(recorder.setSession("a", "sess-old", "epoch-old")).toBe(true);
    const lock = lockPathFor(dir, ".resume-control.json");
    expect(acquireLock(lock)).toBe(true);
    try {
      expect(recorder.setSession("a", "sess-new", "epoch-new")).toBe(false);
    } finally {
      releaseLock(lock);
    }
    observe(recorder, "a", "after-failed-set", [msg("#1", "after failed set")]);
    expect(readRecentEntries(dir, { now: NOW() }).at(-1)?.session_id).toBe("sess-old");
  });

  it("persists the exact repeatedly stalled session in a durable fence", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "codex", now: NOW });
    recorder.setSession("a", "sess-poison", "epoch-poison");
    expect(recorder.forgetSession("a", "stall_recovery", "sess-poison")).toBe(true);

    expect(readRecentEntries(dir, { now: NOW() })[0].system).toEqual({
      type: "stall_recovery",
      time: NOW().toISOString(),
      backend_session_id: "sess-poison",
    });
    expect(recorder.resolveResumeSession("a", "codex")).toEqual({
      kind: "barrier",
      type: "stall_recovery",
      forgottenSessionId: "sess-poison",
      fencedSessionId: "sess-poison",
    });
  });
});

describe("createTimelineRecorder session and filesystem safety", () => {
  it("honors reset barriers for resume and allows a later exact session", () => {
    const dir = mkDir();
    const recorder = createTimelineRecorder({ timelineDirFor: () => dir, providerFor: () => "claude", now: NOW });
    recorder.setSession("a", "sess-1", "epoch-1");
    const first = begin(recorder, "turn-1", "epoch-1");
    recorder.recordInboxPull("a", first, [msg("#1", "old")]);
    recorder.finalizeTurn("a", first);
    expect(recorder.resumeSessionId("a", "claude")).toBe("sess-1");

    recorder.forgetSession("a");
    expect(recorder.resumeSessionId("a", "claude")).toBeNull();
    recorder.setSession("a", "sess-2", "epoch-2");
    const second = begin(recorder, "turn-2", "epoch-2");
    recorder.recordInboxPull("a", second, [msg("#2", "new")]);
    expect(recorder.resumeSessionId("a", "claude")).toBe("sess-2");
    expect(recorder.resumeSessionId("a", "codex")).toBeNull();
  });

  it("does not create or mutate an outside timeline through an agent-directory symlink", () => {
    if (process.platform === "win32") return;
    const base = mkDir();
    const outside = mkDir();
    const agentLink = path.join(base, "agent-link");
    fs.symlinkSync(outside, agentLink);
    const recorder = createTimelineRecorder({
      timelineDirFor: () => path.join(agentLink, ".context_timeline"),
      providerFor: () => "claude",
      now: NOW,
    });
    const owner = begin(recorder, "turn-a");
    recorder.recordInboxPull("a", owner, [msg("#1", "blocked")]);
    recorder.recordAssistantMessage("a", owner, "blocked");
    recorder.finalizeTurn("a", owner);
    recorder.forgetSession("a");

    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
