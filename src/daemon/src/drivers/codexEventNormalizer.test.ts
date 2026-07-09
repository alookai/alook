/**
 * Tests for `CodexEventNormalizer` — in particular the tool_call/tool_output
 * symmetry fix from plans/wire-gated-busy-steering-daemon.md (§9c): before
 * this fix, `handleItemCompleted` had no case for `fileChange`, `webSearch`,
 * or `collabAgentToolCall`, so `outstandingToolUses` (tracked by the manager
 * via these `ParsedEvent`s) would permanently increment on the first such
 * item of a turn and never come back down.
 */
import { describe, it, expect } from "vitest";
import { CodexEventNormalizer } from "./codexEventNormalizer";

function notify(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params });
}

describe("CodexEventNormalizer — tool_call/tool_output symmetry", () => {
  it("fileChange: item/started then item/completed emits tool_call then tool_output", () => {
    const n = new CodexEventNormalizer();
    const started = n.normalizeLine(notify("item/started", { item: { type: "fileChange" } }));
    expect(started).toEqual([{ kind: "tool_call", name: "file_change", input: { type: "fileChange" } }]);

    const completed = n.normalizeLine(notify("item/completed", { item: { type: "fileChange" } }));
    expect(completed).toEqual([{ kind: "tool_output", name: "file_change" }]);
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
