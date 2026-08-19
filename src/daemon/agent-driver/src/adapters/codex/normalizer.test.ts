/**
 * Tests for `CodexEventNormalizer` — in particular the tool_call/tool_output
 * symmetry fix from plans/wire-gated-busy-steering-daemon.md (§9c): before
 * this fix, `handleItemCompleted` had no case for `fileChange`, `webSearch`,
 * or `collabAgentToolCall`, so `outstandingToolUses` (tracked by the manager
 * via these `AdapterEvent`s) would permanently increment on the first such
 * item of a turn and never come back down.
 */
import { describe, it, expect } from "vitest";
import { CodexEventNormalizer } from "./normalizer.js";

function notify(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

function adoptRootTurn(n: CodexEventNormalizer, threadId: string, turnId: string): void {
  n.normalizeLine(notify("thread/started", { thread: { id: threadId } }));
  n.normalizeLine(notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } }));
}

describe("CodexEventNormalizer — tool_call/tool_output symmetry", () => {
  it("fileChange: item/started then item/completed emits tool_call then tool_output", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", { item: { type: "fileChange" } }));
    expect(started).toEqual([{ kind: "tool_call", name: "file_change", input: {} }]);

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "fileChange" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "file_change" }]);
  });

  it("fileChange consumes raw changes at the adapter boundary and emits only an ordered-unique flat path", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", {
      item: {
        type: "fileChange",
        changes: [
          { path: " a.ts ", diff: "secret-a" },
          { path: "" },
          { path: 42 },
          { path: "b.ts", content: "secret-b" },
          { path: "a.ts" },
        ],
        path: "ignored-fallback.ts",
        diff: "top-secret",
        content: "top-secret-content",
      },
    }));

    expect(started).toEqual([
      { kind: "tool_call", name: "file_change", input: { path: "a.ts, b.ts" } },
    ]);
    expect(JSON.stringify(started)).not.toContain("changes");
    expect(JSON.stringify(started)).not.toContain("secret");

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "fileChange" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "file_change" }]);
  });

  it("fileChange flattens a legacy top-level path when changes are absent", () => {
    const started = new CodexEventNormalizer().normalizeLine(notify("item/started", {
      item: { type: "fileChange", path: " legacy.ts ", diff: "secret" },
    }));

    expect(started).toEqual([
      { kind: "tool_call", name: "file_change", input: { path: "legacy.ts" } },
    ]);
  });

  it("fileChange falls back to a valid top-level path when changes contain no valid paths", () => {
    const started = new CodexEventNormalizer().normalizeLine(notify("item/started", {
      item: {
        type: "fileChange",
        changes: [{ path: " " }, { path: 42 }, { diff: "secret" }],
        path: "fallback.ts",
      },
    }));

    expect(started).toEqual([
      { kind: "tool_call", name: "file_change", input: { path: "fallback.ts" } },
    ]);
  });

  it("webSearch: item/started then item/completed emits tool_call then tool_output", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", { item: { type: "webSearch" } }));
    expect(started).toEqual([{ kind: "tool_call", name: "web_search", input: { type: "webSearch" } }]);

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "webSearch" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "web_search" }]);
  });

  it("collabAgentToolCall: item/started then item/completed emits tool_call then tool_output", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", { item: { type: "collabAgentToolCall" } }));
    expect(started).toEqual([{ kind: "tool_call", name: "collab_tool_call", input: { type: "collabAgentToolCall" } }]);

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "collabAgentToolCall" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "collab_tool_call" }]);
  });

  it("commandExecution: item/started then item/completed still pairs correctly (regression — 9b removed markProgress from this handler)", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", { item: { type: "commandExecution" } }));
    expect(started).toEqual([{ kind: "tool_call", name: "shell", input: { type: "commandExecution" } }]);

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "commandExecution" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "shell" }]);
  });

  it("mcpToolCall: item/started then item/completed still pairs correctly (regression — 9b removed markProgress from this handler)", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", { item: { type: "mcpToolCall", name: "search" } }));
    expect(started).toEqual([
      { kind: "tool_call", name: "mcp_search", input: { type: "mcpToolCall", name: "search" } },
    ]);

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "mcpToolCall", name: "search" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "mcp_search" }]);
  });

  it("does not expose canSteerBusy or a turnState field (dead/redundant driver-level gate must not silently reappear)", () => {
    const n = new CodexEventNormalizer();
    expect((n as unknown as { canSteerBusy?: unknown }).canSteerBusy).toBeUndefined();
    expect((n as unknown as { turnState?: unknown }).turnState).toBeUndefined();
  });
});

describe("CodexEventNormalizer — turn id tracking (for turn/steer expectedTurnId)", () => {
  it("captures params.turn.id on turn/started and exposes it via currentTurnId", () => {
    const n = new CodexEventNormalizer();
    expect(n.currentTurnId).toBeNull();
    adoptRootTurn(n, "th_1", "turn_abc");
    expect(n.currentTurnId).toBe("turn_abc");
  });

  it("clears the turn id on turn/completed (no live turn to steer after)", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "th_1", "turn_abc");
    expect(n.currentTurnId).toBe("turn_abc");
    n.normalizeLine(notify("turn/completed", { threadId: "th_1", turn: { id: "turn_abc", status: "completed" } }));
    expect(n.currentTurnId).toBeNull();
  });

  it("clears the turn id on an interrupted/failed turn too", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "th_1", "turn_x");
    n.normalizeLine(notify("turn/completed", { threadId: "th_1", turn: { id: "turn_x", status: "failed" } }));
    expect(n.currentTurnId).toBeNull();
  });

  it("ignores child and unknown completions without clearing or terminating the active root turn", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");

    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "child-thread-1",
      turn: { id: "child-turn-1", status: "completed" },
    }))).toEqual([]);
    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "root-thread",
      turn: { id: "unknown-turn", status: "completed" },
    }))).toEqual([]);
    expect(n.currentSessionId).toBe("root-thread");
    expect(n.currentTurnId).toBe("root-turn");

    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-turn", status: "completed" },
    }))).toEqual([{ kind: "turn_end", sessionId: "root-thread", turnOwner: "codex:root-thread:root-turn" }]);
    expect(n.currentTurnId).toBeNull();
  });

  it("reopens and re-closes only the matching completed root vendor turn", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");
    const completed = notify("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-turn", status: "completed" },
    });

    expect(n.normalizeLine(completed)).toEqual([{ kind: "turn_end", sessionId: "root-thread", turnOwner: "codex:root-thread:root-turn" }]);
    expect(n.currentTurnId).toBeNull();
    expect(n.normalizeLine(completed)).toEqual([]);
    expect(n.normalizeLine(notify("rawResponseItem/completed", {
      threadId: "child-thread",
      turnId: "root-turn",
    }))).toEqual([]);
    expect(n.normalizeLine(notify("rawResponseItem/completed", {
      threadId: "root-thread",
      turnId: "stale-turn",
    }))).toEqual([]);

    expect(n.normalizeLine(notify("rawResponseItem/completed", {
      threadId: "root-thread",
      turnId: "root-turn",
    }))).toEqual([{ kind: "internal_progress", source: "codex_raw_item", itemType: "rawResponseItem" }]);
    expect(n.normalizeLine(completed)).toEqual([{ kind: "turn_end", sessionId: "root-thread", turnOwner: "codex:root-thread:root-turn" }]);
    expect(n.normalizeLine(completed)).toEqual([]);

    expect(n.normalizeLine(notify("turn/started", {
      threadId: "root-thread",
      turn: { id: "next-turn", status: "inProgress" },
    }))).toEqual([
      { kind: "turn_owner", receipt: "codex:root-thread:next-turn" },
      { kind: "thinking", text: "" },
    ]);
    expect(n.normalizeLine(completed)).toEqual([]);
    expect(n.currentTurnId).toBe("next-turn");
  });

  it("clears terminal ownership when a new thread is explicitly adopted and rejects an unowned terminal", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "old-thread", "old-turn");
    n.normalizeLine(notify("turn/completed", {
      threadId: "old-thread",
      turn: { id: "old-turn", status: "completed" },
    }));

    n.adoptThreadId("new-thread");
    expect(n.currentSessionId).toBe("new-thread");
    expect(n.currentTurnId).toBeNull();
    expect(n.normalizeLine(notify("rawResponseItem/completed", {
      threadId: "old-thread",
      turnId: "old-turn",
    }))).toEqual([]);
    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "new-thread",
      turn: { status: "completed" },
    }))).toEqual([]);
  });

  it("ignores child thread and turn announcements after the root is adopted", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");

    expect(n.normalizeLine(notify("thread/started", { thread: { id: "child-thread" } }))).toEqual([]);
    expect(n.normalizeLine(notify("turn/started", {
      threadId: "child-thread",
      turn: { id: "child-turn", status: "inProgress" },
    }))).toEqual([]);
    expect(n.currentSessionId).toBe("root-thread");
    expect(n.currentTurnId).toBe("root-turn");
  });

  it("filters child output and tool events from the root event stream", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");

    expect(n.normalizeLine(notify("item/agentMessage/delta", {
      threadId: "child-thread",
      turnId: "child-turn",
      delta: "child leak",
    }))).toEqual([]);
    expect(n.normalizeLine(notify("item/started", {
      threadId: "child-thread",
      turnId: "child-turn",
      item: { type: "commandExecution", command: "secret" },
    }))).toEqual([]);
    expect(n.currentSessionId).toBe("root-thread");
    expect(n.currentTurnId).toBe("root-turn");
  });
});

describe("CodexEventNormalizer — session_init dedup (result + thread/started notification)", () => {
  function result(id: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id } } });
  }
  it("emits session_init ONCE for a thread announced twice (result then notification)", () => {
    const n = new CodexEventNormalizer();
    const a = n.normalizeLine(result("th_1"));
    const b = n.normalizeLine(notify("thread/started", { thread: { id: "th_1" } }));
    expect(a.filter((e) => e.kind === "session_init")).toHaveLength(1);
    expect(b.filter((e) => e.kind === "session_init")).toHaveLength(0); // deduped
    // but the id is still adopted regardless of which arrived.
    expect(n.currentSessionId).toBe("th_1");
  });
  it("does not let a later child thread result replace the adopted root thread", () => {
    const n = new CodexEventNormalizer();
    n.normalizeLine(result("th_1"));
    const child = n.normalizeLine(result("th_2"));
    expect(child.filter((e) => e.kind === "session_init")).toHaveLength(0);
    expect(n.currentSessionId).toBe("th_1");
  });
  it("adopts the id from the notification even when the result never emitted it (notification first)", () => {
    const n = new CodexEventNormalizer();
    const b = n.normalizeLine(notify("thread/started", { thread: { id: "th_x" } }));
    expect(b.filter((e) => e.kind === "session_init")).toHaveLength(1);
    expect(n.currentSessionId).toBe("th_x");
  });
});

describe("CodexEventNormalizer — complete owned event family", () => {
  it("normalizes diagnostics, telemetry, lifecycle boundaries, fallbacks, and invalid envelopes", () => {
    const n = new CodexEventNormalizer();
    expect(n.normalizeLine(JSON.stringify({ jsonrpc: "2.0", result: {} }))).toEqual([]);
    n.normalizeLine(notify("thread/started", { thread: { id: "root" } }));
    expect(n.normalizeLine(notify("turn/started", { threadId: "root", turn: {} }))).toEqual([]);
    n.normalizeLine(notify("turn/started", { threadId: "root", turn: { id: "turn" } }));
    expect(n.normalizeLine(notify("item/reasoning/textDelta", { threadId: "root", turnId: "turn", delta: "why-now" }))).toEqual([
      { kind: "thinking", text: "why-now" },
    ]);
    expect(n.normalizeLine(notify("item/reasoning/summaryTextDelta", { threadId: "root", turnId: "turn", delta: "why" }))).toEqual([
      { kind: "thinking", text: "why" },
    ]);
    expect(n.normalizeLine(notify("item/agentMessage/delta", { threadId: "root", turnId: "turn", delta: "answer" }))).toEqual([
      { kind: "text", text: "answer" },
    ]);
    expect(n.normalizeLine(notify("warning", { threadId: "root", message: "careful" }))).toEqual([
      { kind: "runtime_diagnostic", severity: "warning", source: "warning", message: "careful" },
    ]);
    expect(n.normalizeLine(notify("configWarning", { threadId: "root", message: "config" }))).toEqual([
      { kind: "runtime_diagnostic", severity: "warning", source: "configWarning", message: "config" },
    ]);
    expect(n.normalizeLine(notify("error", { threadId: "root", message: "failed" }))).toEqual([
      { kind: "error", message: "failed" },
    ]);
    expect(n.normalizeLine(notify("unknown", { threadId: "root" }))).toEqual([]);
    expect(n.normalizeLine(notify("item/started", { threadId: "root", turnId: "turn", item: { type: "contextCompaction" } }))).toEqual([{ kind: "compaction_started" }]);
    expect(n.normalizeLine(notify("item/started", { threadId: "root", turnId: "turn", item: { type: "enteredReviewMode" } }))).toEqual([{ kind: "review_started" }]);
    expect(n.normalizeLine(notify("item/started", { threadId: "root", turnId: "turn", item: { type: "unknown" } }))).toEqual([]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "contextCompaction" } }))).toEqual([{ kind: "compaction_finished" }]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "exitedReviewMode" } }))).toEqual([{ kind: "review_finished" }]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "agentMessage", text: "final" } }))).toEqual([{ kind: "text", text: "final" }]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "reasoning", text: "thought" } }))).toEqual([{ kind: "thinking", text: "thought" }]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "unknown" } }))).toEqual([]);
    expect(n.normalizeLine(notify("thread/tokenUsage/updated", { threadId: "root", tokenUsage: {} }))).toHaveLength(1);
    expect(n.normalizeLine(notify("account/rateLimits/updated", { threadId: "root", rateLimits: {} }))).toHaveLength(1);
    expect(n.normalizeLine(notify("turn/completed", { threadId: "root", turn: { id: "turn", status: "interrupted" } }))).toEqual([
      { kind: "error", message: "Codex turn interrupted" },
      { kind: "turn_end", sessionId: "root", turnOwner: "codex:root:turn" },
    ]);
  });
});
