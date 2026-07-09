import { describe, it, expect } from "vitest";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer";

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

  it("assistant text block → text", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }),
    );
    expect(out).toEqual([{ kind: "text", text: "hi there" }]);
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
      { kind: "thinking", text: "hmm" },
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
      J({ type: "result", subtype: "success", session_id: "s1", usage: { input_tokens: 3, output_tokens: 5 } }),
    );
    const kinds = out.map((e) => e.kind);
    expect(kinds).toContain("turn_end");
    expect(kinds).toContain("telemetry");
  });

  it("result with is_error → error + turn_end", () => {
    const out = new ClaudeEventNormalizer().normalizeLine(
      J({ type: "result", is_error: true, result: "boom", session_id: "s1" }),
    );
    expect(out.some((e) => e.kind === "error" && (e as any).message === "boom")).toBe(true);
    expect(out.some((e) => e.kind === "turn_end")).toBe(true);
  });
});
