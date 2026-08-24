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
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "result", subtype: "success", session_id: "s1", user_message_uuid: "root-1", usage: { input_tokens: 3, output_tokens: 5 } }),
    );
    const kinds = out.map((e) => e.kind);
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("telemetry");
    expect(out).toContainEqual({ kind: "turn_end", sessionId: "s1", turnOwner: "claude:root-1" });
  });

  it("result with is_error → error + turn_end", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "result", is_error: true, result: "boom", session_id: "s1" }),
    );
    expect(out.some((e) => e.kind === "error" && (e as any).message === "boom")).toBe(true);
    expect(out.some((e) => e.kind === "turn_end")).toBe(true);
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
