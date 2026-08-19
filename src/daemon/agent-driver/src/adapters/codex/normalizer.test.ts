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
    n.normalizeLine(notify("turn/started", { threadId: "th_1", turn: { id: "turn_abc", status: "inProgress" } }));
    expect(n.currentTurnId).toBe("turn_abc");
  });

  it("clears the turn id on turn/completed (no live turn to steer after)", () => {
    const n = new CodexEventNormalizer();
    n.normalizeLine(notify("turn/started", { threadId: "th_1", turn: { id: "turn_abc" } }));
    expect(n.currentTurnId).toBe("turn_abc");
    n.normalizeLine(notify("turn/completed", { status: "completed" }));
    expect(n.currentTurnId).toBeNull();
  });

  it("clears the turn id on an interrupted/failed turn too", () => {
    const n = new CodexEventNormalizer();
    n.normalizeLine(notify("turn/started", { threadId: "th_1", turn: { id: "turn_x" } }));
    n.normalizeLine(notify("turn/completed", { status: "failed" }));
    expect(n.currentTurnId).toBeNull();
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
  it("emits session_init again for a DIFFERENT thread (fresh-thread fallback)", () => {
    const n = new CodexEventNormalizer();
    n.normalizeLine(result("th_1"));
    const fresh = n.normalizeLine(result("th_2")); // e.g. missing-rollout fallback fresh thread
    expect(fresh.filter((e) => e.kind === "session_init")).toHaveLength(1);
    expect(n.currentSessionId).toBe("th_2");
  });
  it("adopts the id from the notification even when the result never emitted it (notification first)", () => {
    const n = new CodexEventNormalizer();
    const b = n.normalizeLine(notify("thread/started", { thread: { id: "th_x" } }));
    expect(b.filter((e) => e.kind === "session_init")).toHaveLength(1);
    expect(n.currentSessionId).toBe("th_x");
  });
});
