import { describe, expect, it } from "vitest";
import {
  compareUsage,
  cursorUnsupportedRow,
  dailyDelta,
  extractClaude,
  extractClaudeReadProofs,
  extractCodex,
  extractCodexReadProofs,
  extractCursorTerminal,
  extractCursorToolEvidence,
  extractOpenCode,
  extractOpenCodeEvents,
  extractOpenCodeReadProofs,
  extractPi,
  extractPiReadProofs,
  parseJsonRecords,
  redactedOutputTail,
  redactedStderrTail,
  validateWorkload,
} from "../benchmark-token-usage.mts";

describe("authoritative token-usage benchmark", () => {
  it("parses JSON and JSONL without accepting malformed lines", () => {
    expect(parseJsonRecords('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(() => parseJsonRecords('{"a":1}\nnope')).toThrow("line 2 is not JSON");
  });

  it("keeps failure stdout metadata without retaining prompts or content", () => {
    const tail = redactedOutputTail([
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/update", params: { prompt: "private prompt" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 8, result: { stopReason: "end_turn", content: "private answer" } }),
      "not-json private stderr-like content",
      JSON.stringify({ error: { code: 401, message: "Authorization: Bearer abc.def.secret" } }),
      JSON.stringify({ error: { code: 401, message: "Authorization=Basic dXNlcjpwYXNz" } }),
    ]);
    expect(tail).toEqual([
      { bytes: expect.any(Number), method: "session/update", id: 7 },
      { bytes: expect.any(Number), id: 8, resultKeys: ["content", "stopReason"], stopReason: "end_turn" },
      { bytes: expect.any(Number), unparsed: true },
      { bytes: expect.any(Number), error: { code: 401, message: "Authorization=[REDACTED]" } },
      { bytes: expect.any(Number), error: { code: 401, message: "Authorization=[REDACTED]" } },
    ]);
    expect(JSON.stringify(tail)).not.toContain("private");
    expect(JSON.stringify(tail)).not.toContain("abc.def.secret");
    expect(redactedStderrTail(["failed Authorization: Bearer abc.def.secret\nfailed Authorization=Basic dXNlcjpwYXNz\n{\"Authorization\":\"Bearer json.secret\"}"])).toEqual([
      "failed Authorization=[REDACTED]",
      "failed Authorization=[REDACTED]",
      "{\"Authorization=[REDACTED]\"}",
    ]);
  });

  it("diffs Claude cumulative modelUsage inside one physical launch", () => {
    const turns = extractClaude([
      {
        type: "result", session_id: "s", user_message_uuid: "u1", total_cost_usd: 1,
        modelUsage: { opus: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 30, cacheCreationInputTokens: 8, costUSD: 1 } },
      },
      {
        type: "result", session_id: "s", user_message_uuid: "u2", total_cost_usd: 1.5,
        modelUsage: { opus: { inputTokens: 14, outputTokens: 5, cacheReadInputTokens: 50, cacheCreationInputTokens: 9, costUSD: 1.5 } },
      },
    ], "launch-1");
    expect(turns.map((turn) => turn.usage)).toEqual([
      { input: 10, output: 2, cache: 38 },
      { input: 4, output: 3, cache: 21 },
    ]);
    expect(turns.map((turn) => turn.nativeReportedCost)).toEqual([1, 0.5]);
  });

  it("rejects Claude cumulative regressions and duplicate terminal identities", () => {
    const base = { type: "result", session_id: "s", user_message_uuid: "u", total_cost_usd: 1, modelUsage: { opus: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 1 } } };
    expect(() => extractClaude([base, base], "launch")).toThrow("duplicate Claude provider record");
    expect(() => extractClaude([base, { ...base, user_message_uuid: "u2", modelUsage: { opus: { ...base.modelUsage.opus, inputTokens: 9 } } }], "launch")).toThrow("regressed");
  });

  it("normalizes Codex cache and reasoning as subsets", () => {
    const turns = extractCodex([
      { type: "session_meta", payload: { model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-5" } },
      { method: "rawResponse/completed", params: { threadId: "thread", turnId: "turn", responseId: "response", usage: { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 10, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 } } },
    ]);
    expect(turns[0].usage).toEqual({ input: 50, output: 20, cache: 50 });
    expect(turns[0].nativeReportedTotal).toBe(120);
  });

  it("sums every OpenCode step-finish and adds reasoning to output", () => {
    const turns = extractOpenCode({ info: { id: "session" }, messages: [{ info: { providerID: "p", modelID: "m" }, parts: [
      { type: "step-finish", id: "one", messageID: "a", cost: 0.25, tokens: { total: 15, input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } },
      { type: "step-finish", id: "two", messageID: "b", cost: 0.75, tokens: { total: 40, input: 6, output: 7, reasoning: 8, cache: { read: 9, write: 10 } } },
    ] }] });
    expect(turns[0].usage).toEqual({ input: 7, output: 20, cache: 28 });
    expect(turns[0].providerModels).toEqual(["p/m"]);
    expect(turns[0].nativeReportedCost).toBe(1);
  });

  it("reads active OpenCode v2 step events and preserves missing native totals", () => {
    const rows = [
      { seq: 3, type: "session.next.step.started.1", data: JSON.stringify({ sessionID: "ses_abc", assistantMessageID: "msg_a", model: { providerID: "p", id: "m" } }) },
      { seq: 8, type: "session.next.step.ended.2", data: JSON.stringify({ sessionID: "ses_abc", assistantMessageID: "msg_a", finish: "tool-calls", cost: 0.25, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }) },
      { seq: 10, type: "session.next.step.started.1", data: JSON.stringify({ sessionID: "ses_abc", assistantMessageID: "msg_b", model: { providerID: "p", id: "m" } }) },
      { seq: 13, type: "session.next.step.ended.2", data: JSON.stringify({ sessionID: "ses_abc", assistantMessageID: "msg_b", finish: "stop", cost: 0.75, tokens: { input: 6, output: 7, reasoning: 8, cache: { read: 9, write: 10 } } }) },
    ];
    const turns = extractOpenCodeEvents(rows, "ses_abc");
    expect(turns[0]).toMatchObject({ usage: { input: 7, output: 20, cache: 28 }, nativeReportedTotal: null, derivedTotal: 55, nativeReportedCost: 1 });
    expect(turns[0].providerModels).toEqual(["p/m"]);
  });

  it("rejects empty, dropped-model, and cross-session Claude cumulative snapshots", () => {
    expect(() => extractClaude([{ type: "result", session_id: "s", user_message_uuid: "u", total_cost_usd: 0, modelUsage: {} }], "launch")).toThrow("is empty");
    const first = { type: "result", session_id: "s1", user_message_uuid: "u1", total_cost_usd: 1, modelUsage: { opus: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, costUSD: 1 } } };
    expect(() => extractClaude([first, { ...first, session_id: "s2", user_message_uuid: "u2" }], "launch")).toThrow("session changed");
    expect(() => extractClaude([first, { ...first, user_message_uuid: "u2", total_cost_usd: 0, modelUsage: { sonnet: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } } }], "launch")).toThrow("dropped model opus");
  });

  it("rejects duplicate and cross-thread Codex settled records", () => {
    const identity = [{ type: "turn_context", payload: { model: "gpt-5" } }];
    const record = { method: "rawResponse/completed", params: { threadId: "a", turnId: "turn", responseId: "r", usage: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 3 } } };
    expect(() => extractCodex([...identity, record, record])).toThrow("duplicate Codex");
    expect(() => extractCodex([...identity, record, { ...record, params: { ...record.params, threadId: "b", responseId: "r2" } }])).toThrow("crossed threads");
    expect(() => extractCodex([{ type: "turn_context", payload: { model: " " } }, record])).toThrow("non-empty string");
  });

  it("rejects OpenCode provider-total mismatch and aggregate overflow", () => {
    const part = { type: "step-finish", id: "one", cost: 0, tokens: { total: 2, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    expect(() => extractOpenCode({ info: { id: "s" }, messages: [{ info: { providerID: "p", modelID: "m" }, parts: [part] }] })).toThrow("provider total mismatch");
    const huge = { type: "step-finish", id: "huge", cost: 0, tokens: { total: Number.MAX_SAFE_INTEGER, input: Number.MAX_SAFE_INTEGER, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    expect(() => extractOpenCode({ info: { id: "s" }, messages: [{ info: { providerID: "p", modelID: "m" }, parts: [huge, { ...huge, id: "huge2" }] }] })).toThrow("safe integer range");
  });

  it("requires the read tool, successful terminal, and exact marker", () => {
    const valid = { terminalOutcome: "success", readProofs: [{ callId: "read-1", path: "./package.json", status: "success" as const, source: "fixture" }], assistantMessages: ["BENCHMARK_OK"] };
    expect(() => validateWorkload(valid)).not.toThrow();
    expect(() => validateWorkload({ ...valid, readProofs: [{ callId: "read-1", path: "./package.json", status: "failed", source: "fixture" }] })).toThrow("same native call");
    expect(() => validateWorkload({ ...valid, readProofs: [{ callId: "other", path: "./other.json", status: "success", source: "fixture" }] })).toThrow("same native call");
    expect(() => validateWorkload({ ...valid, assistantMessages: ["almost"] })).toThrow("exact BENCHMARK_OK");
  });

  it("parses the actual Cursor ACP terminal result before declaring unsupported", () => {
    const raw = extractCursorTerminal([{ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn", content: "private provider response" } }]);
    expect(cursorUnsupportedRow({ usageEventCount: 0, after: null, rawTerminalResult: raw, identity: { launchId: "l" } })).toMatchObject({ status: "unsupported_by_active_transport", nativeRaw: { stopReason: "end_turn" }, alookDailyDelta: null });
    expect(JSON.stringify(raw)).not.toContain("private provider response");
    expect(() => extractCursorTerminal([{ result: { stopReason: "end_turn", usage: { inputTokens: 1 } } }])).toThrow("usage-bearing fields");
    expect(() => extractCursorTerminal([{ result: { stopReason: "private-content" } }])).toThrow("unsupported");
    expect(() => extractCursorTerminal([{ result: { stopReason: "end_turn" } }, { result: { stopReason: "cancelled" } }])).toThrow("exactly one");
    expect(() => cursorUnsupportedRow({ usageEventCount: 1, after: null, rawTerminalResult: raw, identity: {} })).toThrow("unexpectedly emitted");
  });

  it("uses Cursor ACP tool_call_update fields as native workload evidence", () => {
    const evidence = extractCursorToolEvidence([
      { method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read File", rawInput: {} } } },
      { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "read-1", title: "Read ./package.json", rawInput: { path: "./package.json" } } } },
      { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "other", title: "Other", status: "completed", rawOutput: { content: "alook-token-benchmark" } } } },
      { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "read-1", title: "Read ./package.json", status: "completed", rawOutput: { content: "alook-token-benchmark" } } } },
      { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BENCHMARK_" } } } },
      { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } } },
    ]);
    expect(evidence.readProofs).toContainEqual({ callId: "read-1", path: "./package.json", status: "success", source: "cursor_acp_tool_update" });
    expect(evidence.assistantMessages).toEqual(["BENCHMARK_OK"]);
    const failed = extractCursorToolEvidence([
      { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "read-1", rawInput: { path: "./package.json" } } } },
      { method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "failed" } } },
    ]);
    expect(failed.readProofs[0].status).toBe("failed");
  });

  it("correlates every provider read start with its own native successful result", () => {
    const claude = extractClaudeReadProofs([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "./package.json" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "other", is_error: false, content: "alook-token-benchmark" }, { type: "tool_result", tool_use_id: "c1", is_error: false, content: "alook-token-benchmark" }] } },
    ]);
    expect(claude[0].status).toBe("success");
    expect(extractClaudeReadProofs([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Read", input: { path: "./package.json" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: "alook-token-benchmark" }] } },
    ])[0].status).toBe("failed");

    const codex = extractCodexReadProofs([
      { type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "x1", input: "read ./package.json" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "other", output: [{ text: JSON.stringify({ exit_code: 0, output: "alook-token-benchmark" }) }] } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "x1", output: [{ text: JSON.stringify({ exit_code: 0, output: "alook-token-benchmark" }) }] } },
    ]);
    expect(codex[0].status).toBe("success");
    expect(extractCodexReadProofs([
      { type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "x1", input: "read ./package.json" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "other", output: [{ text: "alook-token-benchmark" }] } },
    ])[0].status).toBe("failed");

    const opencodeCalled = { seq: 1, type: "session.next.tool.called.1", data: JSON.stringify({ sessionID: "ses_a", callID: "o1", tool: "read", input: { path: "./package.json" } }) };
    expect(extractOpenCodeReadProofs([opencodeCalled, { seq: 2, type: "session.next.tool.success.1", data: JSON.stringify({ sessionID: "ses_a", callID: "o1", structured: { content: "alook-token-benchmark" } }) }], "ses_a")[0].status).toBe("success");
    expect(extractOpenCodeReadProofs([opencodeCalled, { seq: 2, type: "session.next.tool.failed.1", data: JSON.stringify({ sessionID: "ses_a", callID: "o1", error: "failed" }) }], "ses_a")[0].status).toBe("failed");

    const piCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "read", arguments: { path: "./package.json" } }] } };
    expect(extractPiReadProofs([piCall, { type: "message", message: { role: "toolResult", toolCallId: "p1", isError: false, content: [{ type: "text", text: "alook-token-benchmark" }] } }])[0].status).toBe("success");
    expect(extractPiReadProofs([piCall, { type: "message", message: { role: "toolResult", toolCallId: "p1", isError: true, content: [{ type: "text", text: "alook-token-benchmark" }] } }])[0].status).toBe("failed");
  });

  it("sums only settled Pi assistant messages and validates totals and cost", () => {
    const cost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
    const turns = extractPi([
      { type: "session", id: "session" },
      { type: "message", id: "user", message: { role: "user" } },
      { type: "message", id: "a", message: { role: "assistant", provider: "p", model: "m", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost } } },
      { type: "message", id: "b", message: { role: "assistant", provider: "p", model: "m", usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, totalTokens: 26, cost } } },
    ]);
    expect(turns[0].usage).toEqual({ input: 6, output: 8, cache: 22 });
    expect(turns[0].nativeReportedTotal).toBe(36);
    expect(() => extractPi([
      { type: "session", id: "session" },
      { type: "message", id: "bad", message: { role: "assistant", provider: " ", model: "m", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost } } },
    ])).toThrow("non-empty string");
  });

  it("preserves sticky nulls, exact zero, and rejects counter regression", () => {
    expect(dailyDelta(null, { input: 0, output: 2, cache: null })).toEqual({ input: 0, output: 2, cache: null });
    expect(dailyDelta({ input: 1, output: 2, cache: null }, { input: 3, output: 2, cache: null })).toEqual({ input: 2, output: 0, cache: null });
    expect(() => dailyDelta({ input: 2, output: 0, cache: 0 }, { input: 1, output: 0, cache: 0 })).toThrow("regressed");
    expect(() => dailyDelta(null, { input: Number.NaN, output: 0, cache: 0 })).toThrow("safe integer");
    expect(() => dailyDelta(null, { input: -1, output: 0, cache: 0 })).toThrow("safe integer");
    expect(() => dailyDelta(null, { input: Number.MAX_SAFE_INTEGER + 1, output: 0, cache: 0 })).toThrow("safe integer");
  });

  it("reports exact triad differences without equating null and zero", () => {
    expect(compareUsage({ input: 1, output: 2, cache: 3 }, { input: 1, output: 4, cache: 3 })).toEqual({ exact: false, differences: { input: 0, output: 2, cache: 0 } });
    expect(compareUsage({ input: null, output: 0, cache: 0 }, { input: 0, output: 0, cache: 0 }).exact).toBe(false);
  });
});
