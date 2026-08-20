import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../internal/adapter.js";
import { createBuiltinAgentDriverRegistry } from "../registry.js";
import { mapPiSdkEvent } from "../adapters/pi/index.js";
import { runAgentBackendAdapterConformance } from "./conformance.js";

const line = (value: unknown): string => JSON.stringify(value);

describe("builtin adapter protocol conformance", () => {
  const registry = createBuiltinAgentDriverRegistry();

  it("runs the real Claude adapter through the shared normalized-event contract", () => {
    const events = runAgentBackendAdapterConformance(registry.get("claude"), {
      exercise(adapter) {
        const receipt = adapter.beginTurn?.();
        const rootUuid = receipt?.slice("claude:".length);
        return [
          ...adapter.normalizeLine(line({ type: "system", subtype: "init", session_id: "claude-root" })),
          ...adapter.normalizeLine(line({
            type: "user",
            isReplay: true,
            uuid: rootUuid,
            message: { role: "user", content: [{ type: "text", text: "prompt" }] },
          })),
          ...adapter.normalizeLine(line({ type: "assistant", message: { content: [
            { type: "thinking", thinking: "plan" },
            { type: "tool_use", name: "Read", input: { path: "x" } },
          ] } })),
          ...adapter.normalizeLine(line({ type: "user", message: { content: [{ type: "tool_result" }] } })),
          ...adapter.normalizeLine(line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } })),
          ...adapter.normalizeLine(line({
            type: "result",
            subtype: "success",
            session_id: "claude-root",
            user_message_uuid: rootUuid,
          })),
        ];
      },
      expectedEventKinds: ["session_init", "thinking", "tool_call", "tool_output", "text", "turn_end"],
    });
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", sessionId: "claude-root", turnOwner: expect.stringMatching(/^claude:/) });
  });

  it("runs the real Codex adapter and rejects child completion/output in the shared contract", () => {
    const events = runAgentBackendAdapterConformance(registry.get("codex"), {
      exercise(adapter) {
        const rootThread = "codex-root";
        const rootTurn = "root-turn";
        return [
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", id: 2, result: { thread: { id: rootThread } } })),
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", method: "turn/started", params: { threadId: rootThread, turn: { id: rootTurn, status: "inProgress" } } })),
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } } })),
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "child-thread", delta: "must not leak" } })),
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", method: "item/started", params: { threadId: rootThread, turnId: rootTurn, item: { type: "commandExecution" } } })),
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", method: "item/completed", params: { threadId: rootThread, turnId: rootTurn, item: { type: "commandExecution" } } })),
          ...adapter.normalizeLine(line({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: rootThread, turn: { id: rootTurn, status: "completed" } } })),
        ];
      },
      expectedEventKinds: ["session_init", "turn_owner", "thinking", "tool_call", "tool_output", "turn_end"],
    });
    expect(JSON.stringify(events)).not.toContain("must not leak");
  });

  it("declares the real Cursor adapter as a lane-owned persistent ACP transport", () => {
    const adapter = registry.get("cursor").createAdapter();
    expect(adapter.execution).toEqual({
      lifetime: "session",
      transport: { kind: "stdio_rpc", protocol: "cursor.acp.v1" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    });
    expect("normalizeLine" in adapter).toBe(false);
  });

  it("runs the real OpenCode adapter through the shared normalized-event contract", () => {
    runAgentBackendAdapterConformance(registry.get("opencode"), {
      exercise(adapter) {
        return [
          ...adapter.normalizeLine(line({ type: "step_start", sessionID: "opencode-root" })),
          ...adapter.normalizeLine(line({ type: "tool_use", sessionID: "opencode-root", part: { tool: "read", state: { input: {} } } })),
          ...adapter.normalizeLine(line({ type: "step_finish", sessionID: "opencode-root", part: { reason: "tool-calls" } })),
          ...adapter.normalizeLine(line({ type: "text", sessionID: "opencode-root", part: { text: "done" } })),
          ...adapter.normalizeLine(line({ type: "step_finish", sessionID: "opencode-root", part: { reason: "stop" } })),
        ];
      },
      expectedEventKinds: ["session_init", "thinking", "tool_call", "text", "turn_end"],
    });
  });

  it("runs the real Pi adapter registration and SDK mapper through the shared normalized-event contract", () => {
    runAgentBackendAdapterConformance(registry.get("pi"), {
      exercise(adapter) {
        expect(adapter.execution).toEqual({
          lifetime: "session",
          transport: { kind: "in_process_sdk", protocol: "pi_sdk" },
          wakeStart: "immediate",
          terminalOwnership: "prompt_invocation",
        });
        const state = { sawTextDelta: false };
        const vendorEvents = [
          { type: "message_update", delta: { type: "thinking_delta", delta: "plan" } },
          { type: "tool_execution_start", toolName: "read", args: {} },
          { type: "tool_execution_end", toolName: "read" },
          { type: "message_update", delta: { type: "text_delta", delta: "done" } },
          { type: "agent_end" },
        ];
        return vendorEvents.flatMap((event) => mapPiSdkEvent(event, "pi-root", state)) as AdapterEvent[];
      },
      expectedEventKinds: ["thinking", "tool_call", "tool_output", "text"],
      terminalSource: "transport_invocation",
    });
  });
});
