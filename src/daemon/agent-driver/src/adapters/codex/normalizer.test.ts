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
      {
        kind: "turn_owner",
        receipt: "codex:root-thread:next-turn",
        nativeTurnId: "next-turn",
      },
    ]);
    expect(n.normalizeLine(completed)).toEqual([]);
    expect(n.currentTurnId).toBe("next-turn");
  });

  it("classifies retrying stream errors as recovery and preserves nested fatal messages", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");

    expect(n.normalizeLine(notify("error", {
      threadId: "root-thread",
      turnId: "root-turn",
      willRetry: true,
      error: { message: "Reconnecting... 1/5", additionalDetails: "sensitive transport detail" },
    }))).toEqual([{ kind: "runtime_recovery", stage: "retrying", source: "codex_stream" }]);

    expect(n.normalizeLine(notify("error", {
      threadId: "root-thread",
      turnId: "root-turn",
      willRetry: false,
      error: { message: "request failed" },
    }))).toEqual([{ kind: "error", message: "request failed" }]);
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

  it("accounts child raw responses without letting child lifecycle change the root turn", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "shared-turn-id");
    const childUsage = notify("rawResponse/completed", {
      threadId: "child-thread",
      turnId: "shared-turn-id",
      responseId: "child-response",
      usage: {
        inputTokens: 40,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 5,
        outputTokens: 8,
      },
    });
    const rootUsage = notify("rawResponse/completed", {
      threadId: "root-thread",
      turnId: "shared-turn-id",
      responseId: "root-response",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 4,
      },
    });

    expect(n.normalizeLine(childUsage)).toEqual([expect.objectContaining({
      kind: "telemetry",
      usage: { input: 25, output: 8, cache: 15 },
    })]);
    expect(n.normalizeLine(rootUsage)).toEqual([expect.objectContaining({
      kind: "telemetry",
      usage: { input: 17, output: 4, cache: 3 },
    })]);
    expect(n.normalizeLine(childUsage)).toEqual([]);
    expect(n.normalizeLine(rootUsage)).toEqual([]);

    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "child-thread",
      turn: { id: "shared-turn-id", status: "completed" },
    }))).toEqual([]);
    expect(n.currentSessionId).toBe("root-thread");
    expect(n.currentTurnId).toBe("shared-turn-id");
    expect(n.normalizeLine(rootUsage)).toEqual([]);

    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "root-thread",
      turn: { id: "shared-turn-id", status: "completed" },
    }))).toEqual([
      { kind: "turn_end", sessionId: "root-thread", turnOwner: "codex:root-thread:shared-turn-id" },
    ]);
  });

  it("releases child usage at a child compaction completion", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");
    const childUsage = notify("rawResponse/completed", {
      threadId: "child-thread",
      turnId: "child-turn",
      responseId: "child-response",
      usage: { inputTokens: 9, cachedInputTokens: 4, outputTokens: 2 },
    });

    expect(n.normalizeLine(childUsage)).toHaveLength(1);
    expect(n.normalizeLine(childUsage)).toEqual([]);
    expect(n.normalizeLine(notify("item/completed", {
      threadId: "child-thread",
      turnId: "child-turn",
      item: { type: "contextCompaction" },
    }))).toEqual([]);
    expect(n.normalizeLine(childUsage)).toHaveLength(1);
  });

  it("rejects incomplete settlements and releases late root compaction usage", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root-thread", "root-turn");
    expect(n.normalizeLine(notify("rawResponse/completed", {
      threadId: "root-thread",
      turnId: "root-turn",
      responseId: "missing-usage",
    }))).toEqual([]);
    expect(n.normalizeLine(notify("rawResponse/completed", {
      threadId: "root-thread",
      turnId: "root-turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }))).toEqual([]);
    expect(n.normalizeLine(notify("rawResponse/completed", {
      threadId: "root-thread",
      responseId: "missing-turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }))).toEqual([]);

    expect(n.normalizeLine(notify("turn/completed", {
      threadId: "root-thread",
      turn: { id: "root-turn", status: "completed" },
    }))).toHaveLength(1);
    expect(n.normalizeLine(notify("item/completed", {
      threadId: "root-thread",
      turnId: "root-turn",
      item: { type: "contextCompaction" },
    }))).toEqual([{ kind: "compaction_finished" }]);
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
      { kind: "assistant_reasoning_delta", text: "why-now" },
    ]);
    expect(n.normalizeLine(notify("item/reasoning/summaryTextDelta", { threadId: "root", turnId: "turn", delta: "why" }))).toEqual([
      { kind: "assistant_reasoning_delta", text: "why" },
    ]);
    expect(n.normalizeLine(notify("item/agentMessage/delta", { threadId: "root", turnId: "turn", delta: "answer" }))).toEqual([
      { kind: "assistant_message_delta", text: "answer" },
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
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "agentMessage", text: "final" } }))).toEqual([{ kind: "assistant_message_completed", text: "final" }]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "reasoning", text: "thought" } }))).toEqual([{ kind: "assistant_reasoning_completed", text: "thought" }]);
    expect(n.normalizeLine(notify("item/completed", { threadId: "root", turnId: "turn", item: { type: "unknown" } }))).toEqual([]);
    expect(n.normalizeLine(notify("thread/tokenUsage/updated", { threadId: "root", tokenUsage: {} }))).toEqual([]);
    expect(n.normalizeLine(notify("account/rateLimits/updated", { threadId: "root", rateLimits: {} }))).toEqual([]);
    expect(n.normalizeLine(notify("turn/completed", { threadId: "root", turn: { id: "turn", status: "interrupted" } }))).toEqual([
      { kind: "error", message: "Codex turn interrupted" },
      { kind: "turn_end", sessionId: "root", turnOwner: "codex:root:turn" },
    ]);
  });

  it("emits every settled raw response once, ignores the legacy snapshot, and maps Spark quota windows", () => {
    const n = new CodexEventNormalizer();
    adoptRootTurn(n, "root", "turn");
    expect(n.normalizeLine(notify("thread/tokenUsage/updated", {
      threadId: "root",
      tokenUsage: {
        last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 12 },
        total: { inputTokens: 9_999, cachedInputTokens: 8_888, outputTokens: 7_777 },
      },
    }))).toEqual([]);
    const first = notify("rawResponse/completed", {
      threadId: "root",
      turnId: "turn",
      responseId: "response-1",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 10,
        outputTokens: 14,
      },
    });
    expect(n.normalizeLine(first)).toEqual([{
      kind: "telemetry",
      name: "token_usage",
      source: "codex_raw_response_completed",
      usage: { input: 60, output: 14, cache: 60 },
    }]);
    expect(n.normalizeLine(first)).toEqual([]);
    expect(n.normalizeLine(notify("rawResponse/completed", {
      threadId: "root",
      turnId: "turn",
      responseId: "response-2",
      usage: { inputTokens: 30, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 7 },
    }))).toEqual([expect.objectContaining({
      kind: "telemetry",
      usage: { input: 25, output: 7, cache: 5 },
    })]);
    const terminal = n.normalizeLine(notify("turn/completed", {
      threadId: "root",
      turn: { id: "turn", status: "completed" },
    }));
    expect(terminal).toEqual([
      { kind: "turn_end", sessionId: "root", turnOwner: "codex:root:turn" },
    ]);
    expect(n.normalizeLine(first)).toEqual([]);

    adoptRootTurn(n, "root", "turn-2");
    expect(n.normalizeLine(notify("rawResponse/completed", {
      threadId: "root",
      turnId: "turn-2",
      responseId: "response-1",
      usage: { inputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 },
    }))).toHaveLength(1);
    n.normalizeLine(notify("turn/completed", {
      threadId: "root",
      turn: { id: "turn-2", status: "completed" },
    }));

    n.registerQuotaReadRequest(99);
    const quota = n.normalizeLine(JSON.stringify({
      id: 99,
      result: {
        rateLimitsByLimitId: {
          "gpt-5.3-codex-spark": {
        limitName: "Spark",
        planType: "pro",
        primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
          },
        },
      },
    }));
    expect(quota).toHaveLength(1);
    expect(quota[0]).toMatchObject({
      kind: "telemetry",
      name: "rate_limits",
      quota: {
        status: "available",
        planName: "Pro",
        limits: [
          { bucket: { product: { id: "codex-spark" }, model: { id: "gpt-5.3-codex-spark" }, window: { kind: "rolling", durationSeconds: 18_000 } }, usedPercent: 82 },
          { bucket: { product: { id: "codex-spark" }, model: { id: "gpt-5.3-codex-spark" }, window: { kind: "calendar", period: "week" } }, usedPercent: 40 },
        ],
      },
    });
  });

  it("uses one machine-process quota source generation across Codex sessions", () => {
    const first = new CodexEventNormalizer();
    const second = new CodexEventNormalizer();
    first.registerQuotaReadRequest(1);
    second.registerQuotaReadRequest(2);
    const firstFrame = JSON.stringify({
      id: 1,
      result: { rateLimits: {
        primary: { usedPercent: 20, windowDurationMins: 300 },
      } },
    });
    const secondFrame = JSON.stringify({
      id: 2,
      result: { rateLimits: {
        primary: { usedPercent: 20, windowDurationMins: 300 },
      } },
    });
    const firstQuota = first.normalizeLine(firstFrame)[0];
    const secondQuota = second.normalizeLine(secondFrame)[0];
    expect(firstQuota).toMatchObject({ kind: "telemetry", name: "rate_limits" });
    expect(secondQuota).toMatchObject({ kind: "telemetry", name: "rate_limits" });
    if (firstQuota?.kind !== "telemetry" || firstQuota.name !== "rate_limits") throw new Error("missing quota");
    if (secondQuota?.kind !== "telemetry" || secondQuota.name !== "rate_limits") throw new Error("missing quota");
    expect(firstQuota.quota.sourceEpoch).toBe(secondQuota.quota.sourceEpoch);
  });

  it("merges sparse rate-limit notifications into the complete read snapshot", () => {
    const n = new CodexEventNormalizer();
    n.registerQuotaReadRequest(7);
    expect(n.normalizeLine(JSON.stringify({
      id: 7,
      result: {
        rateLimits: {
          primary: { usedPercent: 20, windowDurationMins: 300 },
          secondary: { usedPercent: 40, windowDurationMins: 10_080 },
        },
      },
    }))[0]).toMatchObject({ quota: { limits: [{ usedPercent: 20 }, { usedPercent: 40 }] } });

    const updated = n.normalizeLine(notify("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } },
    }));
    expect(updated[0]).toMatchObject({
      quota: { limits: [{ usedPercent: 25 }, { usedPercent: 40 }] },
    });
  });

  it("rotates the opaque source generation and requires a fresh snapshot after account updates", () => {
    const n = new CodexEventNormalizer();
    n.registerAccountReadRequest(1);
    expect(n.normalizeLine(JSON.stringify({
      id: 1,
      result: { account: { type: "chatgpt", email: "first@example.test", planType: "pro" } },
    }))).toEqual([]);
    n.registerQuotaReadRequest(2);
    const before = n.normalizeLine(JSON.stringify({
      id: 2,
      result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } },
    }))[0];
    if (before?.kind !== "telemetry" || before.name !== "rate_limits") throw new Error("missing quota");

    expect(n.normalizeLine(notify("account/updated", { authMode: "chatgpt", planType: "pro" }))).toEqual([]);
    expect(n.normalizeLine(notify("account/rateLimits/updated", {
      rateLimits: { primary: { usedPercent: 11, windowDurationMins: 300 } },
    }))).toEqual([]);
    n.registerAccountReadRequest(3);
    n.normalizeLine(JSON.stringify({
      id: 3,
      result: { account: { type: "chatgpt", email: "second@example.test", planType: "pro" } },
    }));
    n.registerQuotaReadRequest(4);
    const after = n.normalizeLine(JSON.stringify({
      id: 4,
      result: { rateLimits: { primary: { usedPercent: 11, windowDurationMins: 300 } } },
    }))[0];
    if (after?.kind !== "telemetry" || after.name !== "rate_limits") throw new Error("missing quota");
    expect(after.quota.sourceEpoch).not.toBe(before.quota.sourceEpoch);
  });
});
