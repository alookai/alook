import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent, SpawnedProcessHandle } from "../../internal/adapter.js";
import { createAgentDriverSdk } from "../../sdk.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";
import { GrokAcpLane } from "./acp-lane.js";
import { GrokDriver } from "./index.js";

type RpcMessage = Record<string, unknown>;
type FakeProcess = SpawnedProcessHandle & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  emit(event: string, ...args: unknown[]): boolean;
};

function fakeProcess(onMessage: (process: FakeProcess, message: RpcMessage) => void): FakeProcess {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as FakeProcess;
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onMessage(process, JSON.parse(line) as RpcMessage);
    }
  });
  return process;
}

function send(process: FakeProcess, message: RpcMessage): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(process: FakeProcess, request: RpcMessage, result: unknown): void {
  send(process, { id: request.id, result });
}

function fail(process: FakeProcess, request: RpcMessage, message: string): void {
  send(process, { id: request.id, error: { code: -32000, message } });
}

const modelState = {
  currentModelId: "grok-4.6",
  availableModels: [{
    modelId: "grok-4.6",
    name: "Grok 4.6",
    _meta: {
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: ["xhigh", "high", "medium", "low"],
    },
  }],
};

function context(overrides: Record<string, unknown> = {}) {
  return fakeLaunchContext("grok", "/tmp/grok-acp-test", {
    config: { runtimeConfig: { model: { kind: "default" } } },
    ...overrides,
  });
}

function eventsFrom(lane: GrokAcpLane): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  lane.on("runtime_event", (event) => events.push(event));
  lane.on("error", () => {});
  return events;
}

function installServer(options: {
  sessionId?: string;
  loadError?: string;
  authError?: string;
  replayBeforeSessionResponse?: boolean;
  omitLoadSessionId?: boolean;
  responseSessionId?: string;
  billingError?: string;
  authMethods?: Array<{ id: string }>;
} = {}) {
  const messages: RpcMessage[] = [];
  const prompts: RpcMessage[] = [];
  const sessionId = options.sessionId ?? "grok-session";
  const process = fakeProcess((proc, message) => {
    messages.push(message);
    switch (message.method) {
      case "initialize":
        respond(proc, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: options.authMethods ?? [{ id: "cached_token" }, { id: "grok.com" }],
          _meta: { modelState },
        });
        break;
      case "authenticate":
        if (options.authError) fail(proc, message, options.authError);
        else respond(proc, message, {});
        break;
      case "session/new":
      case "session/load":
        if (options.loadError && message.method === "session/load") {
          fail(proc, message, options.loadError);
          break;
        }
        if (options.replayBeforeSessionResponse) {
          send(proc, {
            method: "session/update",
            params: {
              sessionId,
              _meta: { isReplay: true },
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "must not replay" } },
            },
          });
          send(proc, {
            method: "_x.ai/session/update",
            params: { sessionId, update: { sessionUpdate: "turn_completed" } },
          });
        }
        respond(proc, message, {
          ...(message.method === "session/load" && options.omitLoadSessionId
            ? {}
            : { sessionId: options.responseSessionId ?? sessionId }),
          models: modelState,
        });
        break;
      case "_x.ai/billing":
        if (options.billingError) fail(proc, message, options.billingError);
        else respond(proc, message, {
          subscriptionTier: "SuperGrok",
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              creditUsagePercent: 25,
            },
          },
        });
        break;
      case "session/set_model":
      case "session/close":
        respond(proc, message, {});
        break;
      case "session/prompt":
        prompts.push(message);
        break;
    }
  });
  return { process, messages, prompts };
}

describe("Grok ACP persistent lane", () => {
  it("creates one session, rejects busy input, maps events, and grants active allow-once", async () => {
    const server = installServer({ replayBeforeSessionResponse: true });
    const raw = vi.fn();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context(), {
      onRawStdoutLine: raw,
    });
    const events = eventsFrom(lane);

    await expect(lane.start({ text: "hello", terminalOwner: "root-owner" })).resolves.toEqual({
      ok: true,
      acceptedAs: "prompt",
      receipt: "root-owner",
    });
    expect(lane.currentSessionId).toBe("grok-session");
    expect(server.messages.map((message) => message.method).filter(Boolean)).toEqual([
      "initialize",
      "authenticate",
      "_x.ai/billing",
      "session/new",
      "session/prompt",
    ]);
    expect(server.messages.find((message) => message.method === "session/new")?.params).toMatchObject({
      _meta: { yoloMode: true },
    });
    expect(JSON.stringify(events)).not.toContain("must not replay");
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(0);
    expect(raw).toHaveBeenCalled();

    await expect(lane.send({ text: "busy", mode: "busy" })).resolves.toMatchObject({
      ok: false,
      reason: "runtime_busy",
    });
    expect(server.prompts).toHaveLength(1);
    expect(server.messages.some((message) => String(message.method).includes("interject"))).toBe(false);

    send(server.process, {
      method: "session/request_permission",
      id: "permission-1",
      params: {
        sessionId: "grok-session",
        options: [{ optionId: "deny", kind: "reject_once" }, { optionId: "allow", kind: "allow_once" }],
      },
    });
    expect(server.messages.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });

    send(server.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } },
      },
    });
    send(server.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      },
    });
    send(server.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "plan", entries: [] },
      },
    });
    send(server.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", rawInput: { path: "README.md" } },
      },
    });
    send(server.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read", status: "completed" },
      },
    });
    expect(events).toEqual(expect.arrayContaining([
      { kind: "assistant_reasoning_delta", text: "reason" },
      { kind: "assistant_message_delta", text: "answer" },
      { kind: "internal_progress", source: "grok.acp", itemType: "plan" },
      { kind: "tool_call", callId: "tool-1", name: "Read", input: { path: "README.md" } },
      { kind: "tool_output", callId: "tool-1", name: "Read" },
    ]));

    respond(server.process, server.prompts[0]!, { stopReason: "end_turn" });
    expect(events.filter((event) => event.kind === "turn_end")).toEqual([{
      kind: "turn_end",
      sessionId: "grok-session",
      turnOwner: "root-owner",
    }]);
  });

  it("loads the exact session, gates replay, and only the matching prompt response terminates", async () => {
    const server = installServer({
      sessionId: "saved-session",
      replayBeforeSessionResponse: true,
      omitLoadSessionId: true,
    });
    const lane = new GrokAcpLane(
      { spawn: async () => ({ process: server.process }) },
      context({
        config: {
          sessionId: "saved-session",
          runtimeConfig: { model: { kind: "named", name: "grok-4.6" }, reasoningEffort: "xhigh" },
        },
      }),
    );
    const events = eventsFrom(lane);

    await expect(lane.start({ text: "resume", sessionId: "saved-session" })).resolves.toMatchObject({ ok: true });
    expect(server.messages.map((message) => message.method).filter(Boolean)).toEqual([
      "initialize",
      "authenticate",
      "_x.ai/billing",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
    expect(server.messages.find((message) => message.method === "session/load")?.params).toMatchObject({
      sessionId: "saved-session",
    });
    expect(server.messages.find((message) => message.method === "session/set_model")?.params).toEqual({
      sessionId: "saved-session",
      modelId: "grok-4.6",
      _meta: { reasoningEffort: "xhigh" },
    });
    expect(JSON.stringify(events)).not.toContain("must not replay");

    send(server.process, { id: 999, result: { stopReason: "end_turn" } });
    send(server.process, {
      method: "_x.ai/session/update",
      params: { sessionId: "saved-session", update: { sessionUpdate: "turn_completed" } },
    });
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(0);

    respond(server.process, server.prompts[0]!, { stopReason: "end_turn" });
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
    await expect(lane.send({ text: "second", mode: "idle", terminalOwner: "second-owner" })).resolves.toEqual({
      ok: true,
      acceptedAs: "prompt",
      receipt: "second-owner",
    });
    respond(server.process, server.prompts[0]!, { stopReason: "end_turn" });
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
    respond(server.process, server.prompts[1]!, { stopReason: "end_turn" });
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(2);
  });

  it("cancels only an active prompt and closes the session before killing the process", async () => {
    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    eventsFrom(lane);

    await lane.start({ text: "interrupt me" });
    await expect(lane.interrupt({ requestId: "interrupt-1" })).resolves.toBe(true);
    expect(server.messages.at(-1)).toMatchObject({
      method: "session/cancel",
      params: { sessionId: "grok-session" },
    });
    respond(server.process, server.prompts[0]!, { stopReason: "cancelled" });
    await expect(lane.interrupt({ requestId: "interrupt-2" })).resolves.toBe(false);

    await lane.stop({ reason: "shutdown", forceAfterMs: 10 });
    expect(server.messages.map((message) => message.method).filter(Boolean)).toContain("session/close");
    expect(server.process.kill).toHaveBeenCalledTimes(1);
  });

  it("returns reset-required for a missing saved session and gives bounded auth guidance", async () => {
    const missing = installServer({ sessionId: "missing", loadError: "Session not found" });
    const missingLane = new GrokAcpLane(
      { spawn: async () => ({ process: missing.process }) },
      context({ config: { sessionId: "missing", runtimeConfig: { model: { kind: "default" } } } }),
    );
    eventsFrom(missingLane);
    await expect(missingLane.start({ text: "resume", sessionId: "missing" })).resolves.toEqual({
      ok: false,
      reason: "reset_required",
      error: "Grok session could not be loaded; reset this agent to start a new session",
    });
    expect(missing.messages.some((message) => message.method === "session/new")).toBe(false);

    const auth = installServer({ authError: "token=secret account=user@example.com" });
    const authLane = new GrokAcpLane({ spawn: async () => ({ process: auth.process }) }, context());
    eventsFrom(authLane);
    await expect(authLane.start({ text: "auth" })).resolves.toEqual({
      ok: false,
      reason: "authentication",
      error: "Grok authentication failed; run `grok login` and retry",
    });
    expect(auth.process.kill).toHaveBeenCalledTimes(1);

    const loginRequired = installServer({ authMethods: [{ id: "grok.com" }] });
    const loginRequiredLane = new GrokAcpLane(
      { spawn: async () => ({ process: loginRequired.process }) },
      context(),
    );
    eventsFrom(loginRequiredLane);
    await expect(loginRequiredLane.start({ text: "auth" })).resolves.toEqual({
      ok: false,
      reason: "authentication",
      error: "Grok authentication failed; run `grok login` and retry",
    });
    expect(loginRequired.messages.some((message) => message.method === "authenticate")).toBe(false);
    expect(loginRequired.process.kill).toHaveBeenCalledTimes(1);
  });

  it("requires a loaded session response to preserve the saved session identity", async () => {
    const server = installServer({ sessionId: "saved-session", responseSessionId: "other-session" });
    const lane = new GrokAcpLane(
      { spawn: async () => ({ process: server.process }) },
      context({ config: { sessionId: "saved-session", runtimeConfig: { model: { kind: "default" } } } }),
    );
    eventsFrom(lane);
    await expect(lane.start({ text: "resume", sessionId: "saved-session" })).resolves.toEqual({
      ok: false,
      reason: "reset_required",
      error: "Grok ACP loaded a different session; reset this agent before continuing",
    });
    expect(server.messages.some((message) => message.method === "session/prompt")).toBe(false);
  });

  it("drops replayed text, tools, and terminal updates even after the lane is ready", async () => {
    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const events = eventsFrom(lane);
    await lane.start({ text: "live" });

    for (const update of [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late replay" } },
      { sessionUpdate: "tool_call", toolCallId: "replayed-tool", title: "Replay", rawInput: {} },
    ]) {
      send(server.process, {
        method: "session/update",
        params: { sessionId: "grok-session", _meta: { isReplay: true }, update },
      });
    }
    send(server.process, {
      method: "_x.ai/session/update",
      params: {
        sessionId: "grok-session",
        _meta: { isReplay: true },
        update: { sessionUpdate: "turn_completed", promptId: "alook-4", usage: { inputTokens: 9 } },
      },
    });

    expect(JSON.stringify(events)).not.toContain("late replay");
    expect(JSON.stringify(events)).not.toContain("replayed-tool");
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "telemetry" && event.name === "token_usage")).toHaveLength(0);
  });

  it("prefers prompt-response usage over a same-prompt private fallback and emits it once", async () => {
    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const events = eventsFrom(lane);
    await lane.start({ text: "usage" });
    const prompt = server.prompts[0]!;
    const promptId = (prompt.params as { _meta: { promptId: string } })._meta.promptId;

    send(server.process, {
      method: "_x.ai/session/update",
      params: {
        sessionId: "grok-session",
        update: {
          sessionUpdate: "turn_completed",
          promptId,
          usage: { inputTokens: 999, outputTokens: 999 },
        },
      },
    });
    respond(server.process, prompt, {
      stopReason: "end_turn",
      _meta: {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cachedReadTokens: 10,
          reasoningTokens: 5,
        },
      },
    });
    send(server.process, {
      method: "_x.ai/session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "turn_completed", promptId, usage: { inputTokens: 777 } },
      },
    });

    expect(events.filter((event) => event.kind === "telemetry" && event.name === "token_usage")).toEqual([{
      kind: "telemetry",
      name: "token_usage",
      source: "grok.acp",
      usage: { input: 90, output: 20, cache: 10 },
    }]);
  });

  it("uses same-prompt private usage only as fallback and keeps billing failures nonfatal", async () => {
    const server = installServer({ billingError: "billing unavailable" });
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const events = eventsFrom(lane);
    await lane.start({ text: "fallback" });
    const prompt = server.prompts[0]!;
    const promptId = (prompt.params as { _meta: { promptId: string } })._meta.promptId;
    send(server.process, {
      method: "_x.ai/session/update",
      params: {
        sessionId: "grok-session",
        update: {
          sessionUpdate: "turn_completed",
          promptId,
          usage: { inputTokens: 30, outputTokens: 8, cachedReadTokens: 4, reasoningTokens: 2 },
        },
      },
    });
    respond(server.process, prompt, { stopReason: "end_turn" });
    await vi.waitFor(() => expect(events.some(
      (event) => event.kind === "telemetry" && event.name === "rate_limits" && event.quota.status === "error",
    )).toBe(true));
    expect(events.filter((event) => event.kind === "telemetry" && event.name === "token_usage")).toEqual([{
      kind: "telemetry",
      name: "token_usage",
      source: "grok.acp",
      usage: { input: 26, output: 8, cache: 4 },
    }]);
    expect(events.filter((event) => event.kind === "error")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
  });

  it("preserves Grok authentication as a public authentication failure", async () => {
    const auth = installServer({ authError: "token=secret account=user@example.com" });
    vi.spyOn(GrokDriver.prototype, "openLane").mockImplementation(async (ctx) => (
      new GrokAcpLane({ spawn: async () => ({ process: auth.process }) }, ctx)
    ));
    const sdk = createAgentDriverSdk({ host: createFakeAgentDriverHost() });
    const workingDirectory = await mkdtemp(join(tmpdir(), "grok-public-auth-"));
    try {
      const opened = await sdk.open({
        backend: "grok",
        config: { model: { kind: "default" } },
        launch: {
          workingDirectory,
          instructions: { format: "markdown", content: "" },
          launchId: "grok-public-auth-test",
        },
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const events: unknown[] = [];
      const collecting = (async () => { for await (const event of opened.session.events) events.push(event); })();
      await expect(opened.session.start({ id: "auth", kind: "user", text: "auth" })).resolves.toMatchObject({
        status: "rejected",
        error: { category: "authentication", code: "authentication_required" },
      });
      await opened.session.closed;
      await collecting;
      expect(JSON.stringify(events)).not.toMatch(/secret|user@example\.com/);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
