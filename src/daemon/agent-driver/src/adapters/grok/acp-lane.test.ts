import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, SpawnedProcessHandle } from "../../internal/adapter.js";
import { createAgentDriverSdk } from "../../sdk.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";
import { GrokAcpLane } from "./acp-lane.js";
import { GrokDriver } from "./index.js";

const killProcessTree = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../internal/killTree.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js");
  return { ...actual, killProcessTree };
});

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

function fail(process: FakeProcess, request: RpcMessage, message: string, code = -32000): void {
  send(process, { id: request.id, error: { code, message } });
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
  billingError?: string | { message: string; code: number };
  authMethods?: Array<{ id: string }>;
  initializeResult?: RpcMessage;
  sessionResult?: unknown;
  setModelError?: string;
  onSessionResponse?: () => void;
} = {}) {
  const messages: RpcMessage[] = [];
  const prompts: RpcMessage[] = [];
  const sessionId = options.sessionId ?? "grok-session";
  const process = fakeProcess((proc, message) => {
    messages.push(message);
    switch (message.method) {
      case "initialize":
        respond(proc, message, options.initializeResult ?? {
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
        respond(proc, message, options.sessionResult ?? {
          ...(message.method === "session/load" && options.omitLoadSessionId
            ? {}
            : { sessionId: options.responseSessionId ?? sessionId }),
          models: modelState,
        });
        options.onSessionResponse?.();
        break;
      case "_x.ai/billing":
        if (options.billingError) {
          const failure = typeof options.billingError === "string"
            ? { message: options.billingError, code: -32000 }
            : options.billingError;
          fail(proc, message, failure.message, failure.code);
        }
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
        if (options.setModelError) fail(proc, message, options.setModelError);
        else respond(proc, message, {});
        break;
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
  beforeEach(() => {
    killProcessTree.mockClear();
  });
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

  it("enforces lifecycle and live-settings boundaries", async () => {
    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    eventsFrom(lane);

    await expect(lane.send({ text: "early", mode: "idle" })).resolves.toEqual({
      ok: false,
      reason: "closed",
    });
    await expect(lane.updateSettings({ reasoningEffort: "low" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "settings_session_unavailable", retryable: true },
    });
    await lane.start({ text: "settings" });
    await expect(lane.start({ text: "again" })).resolves.toMatchObject({
      ok: false,
      reason: "runtime_error",
    });
    await expect(lane.updateSettings({ reasoningEffort: "low" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "settings_runtime_busy", retryable: true },
    });
    respond(server.process, server.prompts[0]!, { stopReason: "end_turn" });
    await expect(lane.updateSettings({ reasoningEffort: "max" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "unsupported_reasoning_effort" },
    });
    await expect(lane.updateSettings({ reasoningEffort: "low" })).resolves.toEqual({ status: "applied" });
    expect(server.messages.at(-1)).toMatchObject({
      method: "session/set_model",
      params: { sessionId: "grok-session", modelId: "grok-4.6", _meta: { reasoningEffort: "low" } },
    });

    const noCatalog = installServer({
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cached_token" }],
      },
      sessionResult: { sessionId: "grok-session" },
    });
    const noCatalogLane = new GrokAcpLane(
      { spawn: async () => ({ process: noCatalog.process }) },
      context(),
    );
    eventsFrom(noCatalogLane);
    await noCatalogLane.start({ text: "no catalog" });
    respond(noCatalog.process, noCatalog.prompts[0]!, { stopReason: "end_turn" });
    await expect(noCatalogLane.updateSettings({ reasoningEffort: null })).resolves.toMatchObject({
      status: "failed",
      error: { code: "settings_model_unavailable" },
    });

    const rejected = installServer({ setModelError: "not accepted" });
    const rejectedLane = new GrokAcpLane(
      { spawn: async () => ({ process: rejected.process }) },
      context(),
    );
    eventsFrom(rejectedLane);
    await rejectedLane.start({ text: "reject settings" });
    respond(rejected.process, rejected.prompts[0]!, { stopReason: "end_turn" });
    await expect(rejectedLane.updateSettings({ reasoningEffort: "high" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "settings_update_failed", retryable: true },
    });
  });

  it.each([
    {
      name: "protocol",
      initializeResult: {
        protocolVersion: 2,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "cached_token" }],
      },
      error: "protocol version 1",
    },
    {
      name: "load capability",
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "cached_token" }],
      },
      error: "persistent session loading",
    },
    {
      name: "cached authentication",
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: "other" }],
      },
      error: "cached-token authentication",
    },
  ])("fails the strict handshake without $name", async ({ initializeResult, error }) => {
    const server = installServer({ initializeResult });
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    eventsFrom(lane);
    await expect(lane.start({ text: "strict" })).resolves.toMatchObject({
      ok: false,
      reason: "incompatible_configuration",
      error: expect.stringContaining(error),
    });
  });

  it("rejects malformed session and configured model responses", async () => {
    const loadFailure = installServer({ loadError: "Permission denied" });
    const loadLane = new GrokAcpLane(
      { spawn: async () => ({ process: loadFailure.process }) },
      context({ config: { sessionId: "saved", runtimeConfig: { model: { kind: "default" } } } }),
    );
    eventsFrom(loadLane);
    await expect(loadLane.start({ text: "load", sessionId: "saved" })).rejects.toThrow("Permission denied");

    for (const sessionResult of ["invalid", {}, { sessionId: " " }]) {
      const server = installServer({ sessionResult });
      const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
      eventsFrom(lane);
      await expect(lane.start({ text: "bad session" })).rejects.toThrow(/valid session/);
    }

    const invalidLoaded = installServer({ sessionResult: { sessionId: " " } });
    const invalidLoadedLane = new GrokAcpLane(
      { spawn: async () => ({ process: invalidLoaded.process }) },
      context({ config: { sessionId: "saved", runtimeConfig: { model: { kind: "default" } } } }),
    );
    eventsFrom(invalidLoadedLane);
    await expect(invalidLoadedLane.start({ text: "bad load", sessionId: "saved" }))
      .rejects.toThrow("invalid session id");

    const unavailableModel = installServer();
    const unavailableModelLane = new GrokAcpLane(
      { spawn: async () => ({ process: unavailableModel.process }) },
      context({ config: { runtimeConfig: { model: { kind: "named", name: "missing-model" } } } }),
    );
    eventsFrom(unavailableModelLane);
    await expect(unavailableModelLane.start({ text: "model" })).resolves.toMatchObject({
      ok: false,
      reason: "incompatible_configuration",
      error: expect.stringContaining("model is unavailable"),
    });

    const unavailableEffort = installServer();
    const unavailableEffortLane = new GrokAcpLane(
      { spawn: async () => ({ process: unavailableEffort.process }) },
      context({ config: { runtimeConfig: { model: { kind: "default" }, reasoningEffort: "max" } } }),
    );
    eventsFrom(unavailableEffortLane);
    await expect(unavailableEffortLane.start({ text: "effort" })).resolves.toMatchObject({
      ok: false,
      reason: "incompatible_configuration",
      error: expect.stringContaining("reasoning effort is unavailable"),
    });
  });

  it("settles malformed and failed prompt responses without leaking ownership", async () => {
    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const events = eventsFrom(lane);
    await lane.start({ text: "first" });

    send(server.process, { id: server.prompts[0]!.id, error: {} });
    await expect(lane.send({ text: "second", mode: "idle" })).resolves.toMatchObject({ ok: true });
    send(server.process, { id: server.prompts[1]!.id });
    await expect(lane.send({ text: "third", mode: "idle" })).resolves.toMatchObject({ ok: true });
    respond(server.process, server.prompts[2]!, { stopReason: "vendor_stop" });

    expect(events.filter((event) => event.kind === "error")).toEqual([
      expect.objectContaining({ code: "grok.rpc_error", message: "Grok ACP request failed" }),
      expect.objectContaining({ code: "grok.invalid_response" }),
      expect.objectContaining({ code: "grok.invalid_stop_reason" }),
    ]);
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(3);
    send(server.process, { id: "unknown", result: {} });
  });

  it("diagnoses protocol extensions, unsafe updates, and permission fences", async () => {
    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const events = eventsFrom(lane);
    const stderr: string[] = [];
    lane.on("stderr", (text) => stderr.push(text));
    await lane.start({ text: "protocol" });

    send(server.process, { id: "client-request", method: "terminal_create", params: {} });
    send(server.process, { method: "vendor/extension", params: {} });
    send(server.process, { method: "secret=value", params: {} });
    send(server.process, {
      id: "permission-denied",
      method: "session/request_permission",
      params: { sessionId: "other", options: [{ optionId: "always", kind: "allow_always" }] },
    });
    send(server.process, { method: "_x.ai/models/update", params: modelState });
    const update = (sessionId: string, body: RpcMessage) => send(server.process, {
      method: "session/update",
      params: { sessionId, update: body },
    });
    update("other", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hidden" } });
    update("grok-session", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } });
    update("grok-session", { sessionUpdate: "tool_call", toolCallId: 7, title: "bad" });
    update("grok-session", { sessionUpdate: "current_model_update", model_id: "grok-next" });
    update("grok-session", { sessionUpdate: "vendor_secret" });
    server.process.stderr.write("  warning from grok  \n");

    expect(server.messages).toContainEqual({
      jsonrpc: "2.0",
      id: "client-request",
      error: { code: -32601, message: "Unsupported Grok ACP client request" },
    });
    expect(server.messages).toContainEqual({
      jsonrpc: "2.0",
      id: "permission-denied",
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(stderr).toEqual(["warning from grok"]);

    respond(server.process, server.prompts[0]!, { stopReason: "end_turn" });
    update("grok-session", { sessionUpdate: "plan" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runtime_diagnostic", message: expect.stringContaining("terminal_create") }),
      expect.objectContaining({ kind: "runtime_diagnostic", message: expect.stringContaining("unknown") }),
      expect.objectContaining({ kind: "runtime_diagnostic", message: expect.stringContaining("different session") }),
      expect.objectContaining({ kind: "runtime_diagnostic", message: expect.stringContaining("without an active prompt") }),
    ]));
    expect(JSON.stringify(events)).not.toContain("secret=value");
    expect(JSON.stringify(events)).not.toContain("hidden");
  });

  it.each([
    { code: -32601, expected: "unavailable" },
    { code: 401, expected: "unauthorized" },
  ])("classifies billing RPC error $code as $expected", async ({ code, expected }) => {
    const server = installServer({ billingError: { message: "billing rejected", code } });
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const events = eventsFrom(lane);
    await lane.start({ text: "billing" });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      kind: "telemetry",
      name: "rate_limits",
      quota: expect.objectContaining({ status: "error", code: expected, retryable: false }),
    })));
  });

  it("fails closed on malformed transport and cleans process failures", async () => {
    const timeoutProcess = fakeProcess(() => {});
    const timeoutLane = new GrokAcpLane(
      { spawn: async () => ({ process: timeoutProcess }) },
      context(),
      { handshakeTimeoutMs: 5 },
    );
    eventsFrom(timeoutLane);
    await expect(timeoutLane.start({ text: "timeout" })).rejects.toThrow("initialize timed out");

    const unwritable = fakeProcess(() => {});
    unwritable.stdin.end();
    const unwritableLane = new GrokAcpLane({ spawn: async () => ({ process: unwritable }) }, context());
    eventsFrom(unwritableLane);
    await expect(unwritableLane.start({ text: "write" })).rejects.toThrow("stdin is not writable");

    const omittedResult = fakeProcess((process, message) => {
      if (message.method === "initialize") send(process, { id: message.id });
    });
    const omittedResultLane = new GrokAcpLane(
      { spawn: async () => ({ process: omittedResult }) },
      context(),
    );
    eventsFrom(omittedResultLane);
    await expect(omittedResultLane.start({ text: "omitted result" })).rejects.toThrow("response omitted result");

    let promptWriteServer!: ReturnType<typeof installServer>;
    promptWriteServer = installServer({ onSessionResponse: () => promptWriteServer.process.stdin.end() });
    const promptWriteLane = new GrokAcpLane(
      { spawn: async () => ({ process: promptWriteServer.process }) },
      context(),
    );
    eventsFrom(promptWriteLane);
    await expect(promptWriteLane.start({ text: "prompt write" })).rejects.toThrow("stdin is not writable");

    const server = installServer();
    const lane = new GrokAcpLane({ spawn: async () => ({ process: server.process }) }, context());
    const errors: Error[] = [];
    const exits: unknown[] = [];
    const events = eventsFrom(lane);
    lane.on("error", (error) => errors.push(error instanceof Error ? error : new Error(String(error))));
    lane.on("exit", (value) => exits.push(value));
    await lane.start({ text: "runtime" });
    send(server.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "tool_call", toolCallId: "open", title: "Open", rawInput: {} },
      },
    });
    server.process.emit("error", new Error("EIO"));
    server.process.emit("error", new Error("duplicate"));
    await vi.waitFor(() => expect(exits).toEqual([{ code: null, signal: null, reason: "runtime_exit" }]));
    expect(errors).toEqual([new Error("EIO")]);
    expect(events).toContainEqual({ kind: "tool_output", callId: "open", name: "Open" });
    await vi.waitFor(() => expect(server.process.kill).toHaveBeenCalledOnce());

    const startupMessages: RpcMessage[] = [];
    const startup = fakeProcess((_process, message) => startupMessages.push(message));
    const startupLane = new GrokAcpLane(
      { spawn: async () => ({ process: startup }) },
      context(),
      { handshakeTimeoutMs: 1_000 },
    );
    const startupErrors: Error[] = [];
    startupLane.on("runtime_event", () => {});
    startupLane.on("error", (error) => startupErrors.push(error instanceof Error ? error : new Error(String(error))));
    const starting = startupLane.start({ text: "startup" });
    await vi.waitFor(() => expect(startupMessages.map((message) => message.method)).toEqual(["initialize"]));
    startup.emit("error", new Error("startup EIO"));
    await expect(starting).rejects.toThrow("startup EIO");
    expect(startupErrors).toEqual([new Error("startup EIO")]);

    const exited = installServer();
    const exitedLane = new GrokAcpLane({ spawn: async () => ({ process: exited.process }) }, context());
    const exitedEvents = eventsFrom(exitedLane);
    const exitedSignals: unknown[] = [];
    exitedLane.on("exit", (value) => exitedSignals.push(value));
    await exitedLane.start({ text: "exit" });
    send(exited.process, {
      method: "session/update",
      params: {
        sessionId: "grok-session",
        update: { sessionUpdate: "tool_call", toolCallId: "exit-tool", title: "Exit", rawInput: {} },
      },
    });
    exited.process.emit("exit", 17, null);
    expect(exitedSignals).toEqual([{ code: 17, signal: null, reason: "runtime_exit" }]);
    expect(exitedEvents).toContainEqual({ kind: "tool_output", callId: "exit-tool", name: "Exit" });
  });

  it("covers stop races, protocol failures, close fallback, and detached cleanup", async () => {
    let releaseSpawn!: (value: { process: FakeProcess }) => void;
    const delayedProcess = fakeProcess(() => {});
    const delayedLane = new GrokAcpLane({
      spawn: () => new Promise((resolve) => { releaseSpawn = resolve; }),
    }, context());
    eventsFrom(delayedLane);
    const delayedStart = delayedLane.start({ text: "delayed" });
    const delayedStop = delayedLane.stop({ reason: "race", forceAfterMs: 0 });
    releaseSpawn({ process: delayedProcess });
    await delayedStop;
    await expect(delayedStart).rejects.toThrow("start was cancelled");

    let finalLane!: GrokAcpLane;
    const finalServer = installServer({ onSessionResponse: () => {
      void finalLane.stop({ reason: "race", forceAfterMs: 0 });
    } });
    finalLane = new GrokAcpLane({ spawn: async () => ({ process: finalServer.process }) }, context());
    eventsFrom(finalLane);
    await expect(finalLane.start({ text: "final race" })).rejects.toThrow("start was cancelled");

    const protocolServer = installServer();
    const protocolLane = new GrokAcpLane(
      { spawn: async () => ({ process: protocolServer.process }) },
      context(),
    );
    const protocolErrors: Error[] = [];
    protocolLane.on("runtime_event", () => {});
    protocolLane.on("error", (error) => protocolErrors.push(error instanceof Error ? error : new Error(String(error))));
    await protocolLane.start({ text: "protocol" });
    protocolServer.process.stdout.write("{not-json}\n");
    await vi.waitFor(() => expect(protocolErrors).toContainEqual(new Error("Grok ACP emitted malformed JSON")));

    const replyFailureServer = installServer();
    const replyFailureLane = new GrokAcpLane(
      { spawn: async () => ({ process: replyFailureServer.process }) },
      context(),
    );
    const replyFailureErrors: Error[] = [];
    replyFailureLane.on("runtime_event", () => {});
    replyFailureLane.on("error", (error) => replyFailureErrors.push(error instanceof Error ? error : new Error(String(error))));
    await replyFailureLane.start({ text: "reply failure" });
    replyFailureServer.process.stdin.end();
    send(replyFailureServer.process, { id: "client-request", method: "terminal_create", params: {} });
    await vi.waitFor(() => expect(replyFailureErrors).toContainEqual(
      new Error("Grok ACP could not answer a client-side protocol request"),
    ));

    for (const wire of [{ jsonrpc: "1.0" }, { jsonrpc: "2.0" }]) {
      const wireServer = installServer();
      const wireLane = new GrokAcpLane({ spawn: async () => ({ process: wireServer.process }) }, context());
      const wireErrors: Error[] = [];
      wireLane.on("runtime_event", () => {});
      wireLane.on("error", (error) => wireErrors.push(error instanceof Error ? error : new Error(String(error))));
      await wireLane.start({ text: "wire" });
      send(wireServer.process, wire);
      await vi.waitFor(() => expect(wireErrors).toHaveLength(1));
    }

    const closeServer = installServer();
    Object.defineProperty(closeServer.process, "pid", { value: 41_001, configurable: true });
    const closeLane = new GrokAcpLane({ spawn: async () => ({ process: closeServer.process }) }, context());
    eventsFrom(closeLane);
    await closeLane.start({ text: "close" });
    closeServer.process.stdin.end();
    await closeLane.stop({ reason: "test", forceAfterMs: 10 });
    expect(killProcessTree).toHaveBeenCalledWith(41_001, { graceMs: 10 });
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
