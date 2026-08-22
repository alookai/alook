import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../internal/adapter.js";
import { createBuiltinAgentDriverRegistry } from "../registry.js";
import { mapPiSdkEvent } from "../adapters/pi/index.js";
import { runAgentBackendAdapterConformance } from "./conformance.js";

const line = (value: unknown): string => JSON.stringify(value);

describe("builtin adapter protocol conformance", () => {
  const registry = createBuiltinAgentDriverRegistry();

  it("locks the exact built-in lifetime, transport, delivery, and terminal-owner matrix", () => {
    const expected = {
      claude: ["session", "stdio_stream", "claude.stream-json.v1", "safe_boundary_queue", "vendor_message"],
      codex: ["session", "stdio_rpc", "codex.app-server.v1", "safe_boundary_queue", "transport_request"],
      cursor: ["session", "stdio_rpc", "cursor.acp.v1", "next_turn_queue", "transport_request"],
      opencode: ["session", "http_sse", "opencode.v2.service.1.17.20", "steer", "transport_request"],
      pi: ["session", "in_process_sdk", "pi_sdk", "steer", "prompt_invocation"],
    } as const;
    const actual = Object.fromEntries(registry.backendIds.map((backend) => {
      const registration = registry.get(backend);
      const execution = registration.createAdapter().execution;
      return [backend, [
        execution.lifetime,
        execution.transport.kind,
        execution.transport.protocol,
        registration.capabilities.midTurnDelivery,
        execution.terminalOwnership,
      ]];
    }));
    expect(actual).toEqual(expected);
  });

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

  it("declares the real OpenCode adapter as a lane-owned persistent v2 service", () => {
    const adapter = registry.get("opencode").createAdapter();
    expect(adapter.execution).toEqual({
      lifetime: "session",
      transport: { kind: "http_sse", protocol: "opencode.v2.service.1.17.20" },
      wakeStart: "immediate",
      terminalOwnership: "transport_request",
    });
    expect("normalizeLine" in adapter).toBe(false);
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
