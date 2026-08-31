import { describe, it, expect } from "vitest";
import { ClaudeEventNormalizer } from "./normalizer.js";

const J = (o: unknown) => JSON.stringify(o);

describe("ClaudeEventNormalizer.normalizeLine", () => {
  it("returns nothing for non-JSON lines", () => {
    expect(new ClaudeEventNormalizer().normalizeLine("not json")).toEqual([]);
  });

  it("system/init → session_init and records the session id", () => {
    const n = new ClaudeEventNormalizer();
    const out = n.normalizeLine(J({ type: "system", subtype: "init", session_id: "s1" }));
    expect(out).toEqual([{ kind: "session_init", sessionId: "s1" }]);
    expect(n.currentSessionId).toBe("s1");
  });

  it("combines assistant text blocks into one completed message", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "assistant", message: { content: [
        { type: "text", text: "hi " },
        { type: "text", text: "there" },
      ] } }),
    );
    expect(out).toEqual([{ kind: "assistant_message_completed", text: "hi there" }]);
  });

  it("assistant thinking + tool_use blocks", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "tool_use", name: "Bash", input: { cmd: "ls" } },
          ],
        },
      }),
    );
    expect(out).toEqual([
      { kind: "assistant_reasoning_completed", text: "hmm" },
      { kind: "tool_call", name: "Bash", input: { cmd: "ls" } },
    ]);
  });

  it("user tool_result → tool_output", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "user", message: { content: [{ type: "tool_result", content: "done" }] } }),
    );
    expect(out).toEqual([{ kind: "tool_output", name: "" }]);
  });

  it("compaction lifecycle", () => {
    const n = new ClaudeEventNormalizer();
    expect(n.normalizeLine(J({ type: "system", subtype: "status", status: "compacting" }))).toEqual([
      { kind: "compaction_started" },
    ]);
    expect(n.normalizeLine(J({ type: "system", subtype: "compact_boundary" }))).toEqual([
      { kind: "compaction_finished" },
    ]);
  });

  it("result → telemetry + turn_end", () => {
    const n = new ClaudeEventNormalizer();
    const line = J({ type: "result", subtype: "success", session_id: "s1", user_message_uuid: "root-1", usage: { input_tokens: 3, output_tokens: 5 } });
    const out = n.normalizeLine(line);
    const kinds = out.map((e) => e.kind);
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("telemetry");
    expect(out).toContainEqual({ kind: "turn_end", sessionId: "s1", turnOwner: "claude:root-1" });
    expect(out).toContainEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_usage",
      usage: {
        input: 3,
        output: 5,
        cache: null,
      },
    });
    expect(n.normalizeLine(line).filter((event) => event.kind === "telemetry")).toEqual([]);
    n.beginTurn();
    expect(n.normalizeLine(line).filter((event) => event.kind === "telemetry")).toHaveLength(1);
  });

  it("projects launch-scoped cumulative modelUsage high-water deltas across logical turns", () => {
    const n = new ClaudeEventNormalizer();
    const first = J({
      type: "result",
      subtype: "success",
      session_id: "s1",
      user_message_uuid: "root-1",
      total_cost_usd: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {
        opus: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 8,
          costUSD: 1,
        },
      },
    });
    expect(n.normalizeLine(first)).toContainEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_model_usage",
      usage: { input: 10, output: 2, cache: 38 },
    });

    n.beginTurn();
    const second = J({
      type: "result",
      subtype: "success",
      session_id: "s1",
      user_message_uuid: "root-2",
      total_cost_usd: 1.7,
      usage: { input_tokens: 2, output_tokens: 2 },
      modelUsage: {
        opus: {
          inputTokens: 14,
          outputTokens: 5,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 9,
          costUSD: 1.5,
        },
        sonnet: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 3,
          costUSD: 0.2,
        },
      },
    });
    expect(n.normalizeLine(second)).toContainEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_model_usage",
      usage: { input: 6, output: 4, cache: 24 },
    });
    expect(n.normalizeLine(second).filter((event) => event.kind === "telemetry")).toEqual([]);

    n.beginTurn();
    const unchanged = JSON.parse(second);
    unchanged.user_message_uuid = "root-3";
    expect(n.normalizeLine(J(unchanged)).filter((event) => event.kind === "telemetry")).toEqual([]);
  });

  it("fails cumulative modelUsage closed after session, model-set, component, or cost corruption", () => {
    const snapshot = (overrides: Record<string, unknown> = {}) => ({
      type: "result",
      subtype: "success",
      session_id: "s1",
      user_message_uuid: "root-1",
      total_cost_usd: 1,
      modelUsage: {
        opus: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 8,
          costUSD: 1,
        },
      },
      ...overrides,
    });
    const telemetry = (normalizer: ClaudeEventNormalizer, event: unknown) => normalizer
      .normalizeLine(J(event))
      .filter((item) => item.kind === "telemetry");

    const changedSession = new ClaudeEventNormalizer();
    expect(telemetry(changedSession, snapshot())).toHaveLength(1);
    changedSession.beginTurn();
    expect(telemetry(changedSession, snapshot({ session_id: "s2", user_message_uuid: "root-2" }))).toEqual([]);
    changedSession.beginTurn();
    expect(telemetry(changedSession, snapshot({ user_message_uuid: "root-3", usage: { input_tokens: 999 } }))).toEqual([]);

    const droppedModel = new ClaudeEventNormalizer();
    const withSecondModel = snapshot({
      total_cost_usd: 1.5,
      modelUsage: {
        ...snapshot().modelUsage,
        sonnet: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          costUSD: 0.5,
        },
      },
    });
    expect(telemetry(droppedModel, withSecondModel)).toHaveLength(1);
    droppedModel.beginTurn();
    expect(telemetry(droppedModel, snapshot({ user_message_uuid: "root-2" }))).toEqual([]);
    droppedModel.beginTurn();
    expect(telemetry(droppedModel, snapshot({
      user_message_uuid: "root-3",
      total_cost_usd: 1.7,
      modelUsage: {
        opus: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadInputTokens: 31,
          cacheCreationInputTokens: 9,
          costUSD: 1.1,
        },
        sonnet: {
          inputTokens: 2,
          outputTokens: 2,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 2,
          costUSD: 0.6,
        },
      },
    }))).toContainEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_model_usage",
      usage: { input: 3, output: 2, cache: 4 },
    });

    const regressed = new ClaudeEventNormalizer();
    expect(telemetry(regressed, snapshot())).toHaveLength(1);
    regressed.beginTurn();
    expect(telemetry(regressed, snapshot({
      user_message_uuid: "root-2",
      total_cost_usd: 0.9,
      modelUsage: {
        opus: {
          ...snapshot().modelUsage.opus,
          inputTokens: 9,
          costUSD: 0.9,
        },
      },
    }))).toEqual([]);
    regressed.beginTurn();
    expect(telemetry(regressed, snapshot({
      user_message_uuid: "root-3",
      total_cost_usd: 1.2,
      modelUsage: {
        opus: {
          inputTokens: 15,
          outputTokens: 3,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 8,
          costUSD: 1.2,
        },
      },
    }))).toContainEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_model_usage",
      usage: { input: 5, output: 1, cache: 0 },
    });

    const mismatchedCost = new ClaudeEventNormalizer();
    expect(telemetry(mismatchedCost, snapshot({ total_cost_usd: 2 }))).toEqual([]);

    const malformedThenValid = new ClaudeEventNormalizer();
    expect(telemetry(malformedThenValid, snapshot({
      usage: { input_tokens: 999, output_tokens: 999 },
      modelUsage: { opus: { ...snapshot().modelUsage.opus, inputTokens: "bad" } },
    }))).toEqual([]);
    malformedThenValid.beginTurn();
    expect(telemetry(malformedThenValid, snapshot({ user_message_uuid: "root-2" }))).toContainEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "claude_result_model_usage",
      usage: { input: 10, output: 2, cache: 38 },
    });

    const legacyThenCumulative = new ClaudeEventNormalizer();
    expect(telemetry(legacyThenCumulative, {
      type: "result",
      subtype: "success",
      session_id: "s1",
      user_message_uuid: "legacy-1",
      usage: { input_tokens: 3, output_tokens: 2 },
    })).toHaveLength(1);
    legacyThenCumulative.beginTurn();
    expect(telemetry(legacyThenCumulative, snapshot({ user_message_uuid: "root-2" }))).toEqual([]);
  });

  it("covers malformed cumulative snapshots and cumulative-to-legacy mode changes", () => {
    const model = (overrides: Record<string, unknown> = {}) => ({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 8,
      costUSD: 1,
      ...overrides,
    });
    const result = (overrides: Record<string, unknown> = {}) => ({
      type: "result",
      subtype: "success",
      session_id: "s1",
      user_message_uuid: "root-1",
      total_cost_usd: 1,
      modelUsage: { opus: model() },
      ...overrides,
    });
    const telemetry = (normalizer: ClaudeEventNormalizer, event: unknown) => normalizer
      .normalizeLine(J(event))
      .filter((item) => item.kind === "telemetry");

    for (const malformed of [
      result({ modelUsage: null }),
      result({ modelUsage: {} }),
      result({ modelUsage: { " ": model() } }),
    ]) {
      expect(telemetry(new ClaudeEventNormalizer(), malformed)).toEqual([]);
    }

    const malformedCrossSession = new ClaudeEventNormalizer();
    expect(telemetry(malformedCrossSession, result({
      modelUsage: { opus: model({ inputTokens: "bad" }) },
    }))).toEqual([]);
    malformedCrossSession.beginTurn();
    expect(telemetry(malformedCrossSession, result({
      session_id: "s2",
      user_message_uuid: "root-2",
    }))).toEqual([]);

    const countOverflow = new ClaudeEventNormalizer();
    expect(telemetry(countOverflow, result({
      total_cost_usd: 0,
      modelUsage: {
        opus: model({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }),
        sonnet: model({ inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }),
      },
    }))).toEqual([]);

    const costOverflow = new ClaudeEventNormalizer();
    expect(telemetry(costOverflow, result({
      total_cost_usd: undefined,
      modelUsage: {
        opus: model({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: Number.MAX_VALUE }),
        sonnet: model({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: Number.MAX_VALUE }),
      },
    }))).toEqual([]);

    const costRegression = new ClaudeEventNormalizer();
    expect(telemetry(costRegression, result())).toHaveLength(1);
    costRegression.beginTurn();
    expect(telemetry(costRegression, result({
      user_message_uuid: "root-2",
      total_cost_usd: 0.9,
      modelUsage: { opus: model({ costUSD: 0.9 }) },
    }))).toEqual([]);

    const cumulativeThenLegacy = new ClaudeEventNormalizer();
    expect(telemetry(cumulativeThenLegacy, result())).toHaveLength(1);
    cumulativeThenLegacy.beginTurn();
    expect(telemetry(cumulativeThenLegacy, {
      type: "result",
      subtype: "success",
      session_id: "s1",
      user_message_uuid: "root-2",
      usage: { input_tokens: 999, output_tokens: 999 },
    })).toEqual([]);
    cumulativeThenLegacy.beginTurn();
    expect(telemetry(cumulativeThenLegacy, result({ user_message_uuid: "root-3" }))).toEqual([]);
  });

  it("does not emit usage without a backend session identity", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "result", subtype: "success", usage: { input_tokens: 3, output_tokens: 5 } }),
    );
    expect(out).toEqual([{ kind: "turn_end", sessionId: undefined }]);
  });

  it("uses request_id and the invocation fallback when root request identity is absent", () => {
    const n = new ClaudeEventNormalizer();
    const withRequestId = J({
      type: "result",
      subtype: "success",
      session_id: "s1",
      request_id: "request-1",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    expect(n.normalizeLine(withRequestId).filter((event) => event.kind === "telemetry")).toHaveLength(1);
    expect(n.normalizeLine(withRequestId).filter((event) => event.kind === "telemetry")).toEqual([]);

    n.beginTurn();
    const withoutRequestId = J({
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(n.normalizeLine(withoutRequestId).filter((event) => event.kind === "telemetry")).toHaveLength(1);
    expect(n.normalizeLine(withoutRequestId).filter((event) => event.kind === "telemetry")).toEqual([]);
  });

  it("result with is_error → error + turn_end", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "result", is_error: true, result: "boom", session_id: "s1" }),
    );
    expect(out).toContainEqual({
      kind: "error",
      code: "claude.result_error",
      message: "boom",
    });
    expect(out.some((e) => e.kind === "turn_end")).toBe(true);
  });

  it.each([
    ["error_max_turns", "claude.error_max_turns"],
    ["error_during_execution", "claude.error_during_execution"],
    ["error_max_budget_usd", "claude.error_max_budget_usd"],
    ["error_max_structured_output_retries", "claude.error_max_structured_output_retries"],
    ["secret/provider/value", "claude.result_error"],
  ])("maps Claude result subtype %s to %s", (subtype, code) => {
    expect(new ClaudeEventNormalizer().normalizeLine(J({
      type: "result",
      subtype,
      is_error: true,
      result: "provider failed",
      session_id: "s1",
    }))).toContainEqual({
      kind: "error",
      code,
      message: "provider failed",
    });
  });

  it("classifies recognized assistant API errors without parsing text into a code", () => {
    expect(new ClaudeEventNormalizer().normalizeLine(J({
      type: "assistant",
      message: { content: [{ type: "text", text: "API Error: 429 rate limited" }] },
    }))).toEqual([{
      kind: "error",
      code: "claude.api_error",
      message: "API Error: 429 rate limited",
    }]);
  });

  it("errored result emits `error` BEFORE the trailing `turn_end` (the ordering B1's errored-turn marker relies on)", () => {
    // managerRuntime buffers the `error`'s message on the way past, then reads
    // it out when the trailing `turn_end` arrives to stamp `endReason:"errored"`.
    // That handoff only works if error precedes turn_end in the SAME batch.
    // See plans/daemon-runtime-error-rewake.md B1.
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "result", is_error: true, result: "boom", session_id: "s1" }),
    );
    const kinds = out.map((e) => e.kind);
    expect(kinds.indexOf("error")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("error")).toBeLessThan(kinds.indexOf("turn_end"));
  });

  it("binds terminals to provider user-message UUIDs rather than payload content", () => {
    const n = new ClaudeEventNormalizer();
    const first = J({ type: "result", subtype: "success", session_id: "s1", user_message_uuid: "first" });
    const second = J({ type: "result", subtype: "success", session_id: "s1", user_message_uuid: "second" });
    expect(n.normalizeLine(first)).toEqual([{ kind: "turn_end", sessionId: "s1", turnOwner: "claude:first" }]);
    expect(n.normalizeLine(second)).toEqual([{ kind: "turn_end", sessionId: "s1", turnOwner: "claude:second" }]);
  });
});
