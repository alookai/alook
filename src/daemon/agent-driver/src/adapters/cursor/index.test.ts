import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterLaunchContext, RuntimeLane, SpawnedProcessHandle } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { CursorDriver } from "./index.js";

type RpcMessage = Record<string, unknown>;
type FakeProcess = SpawnedProcessHandle & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  finish(code?: number | null, signal?: NodeJS.Signals | null): void;
};

let lastSpawn: { command: string; args: string[]; opts: unknown } | null = null;
let spawned: FakeProcess[] = [];
let onClientMessage: (process: FakeProcess, message: RpcMessage) => void = () => {};
let killEmitsExit = false;

function fakeProcess(): FakeProcess {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      if (killEmitsExit) {
        process.signalCode = signal;
        process.emit("exit", null, signal);
      }
      return true;
    }),
    finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      process.exitCode = code;
      process.signalCode = signal;
      process.emit("exit", code, signal);
    },
  });
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onClientMessage(process as FakeProcess, JSON.parse(line));
  });
  return process as unknown as FakeProcess;
}

vi.mock("../../internal/killTree.js", async () => {
  const actual = await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js");
  return {
    ...actual,
    spawnAgentProcess: (command: string, args: string[], opts: unknown) => {
      lastSpawn = { command, args, opts };
      const process = fakeProcess();
      spawned.push(process);
      return process as never;
    },
  };
});

const temporaryDirectories: string[] = [];

function baseCtx(overrides: Partial<AdapterLaunchContext> = {}): AdapterLaunchContext {
  const workingDirectory = mkdtempSync(join(tmpdir(), "cursor-acp-test-"));
  temporaryDirectories.push(workingDirectory);
  return fakeLaunchContext("cursor", workingDirectory, {
    standingPrompt: "You are Cursor.",
    prompt: "say hi",
    config: { runtimeConfig: { model: { kind: "default" } } },
    ...overrides,
  });
}

function respond(process: FakeProcess, request: RpcMessage, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}

function fail(process: FakeProcess, request: RpcMessage, message: string, data?: unknown): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32000, message, ...(data === undefined ? {} : { data }) },
  })}\n`);
}

interface FakeServer {
  readonly messages: RpcMessage[];
  readonly prompts: RpcMessage[];
}

function installServer(options: {
  sessionId?: string;
  loadError?: string;
  modelOptions?: Array<{ value: string; name: string }>;
} = {}): FakeServer {
  const messages: RpcMessage[] = [];
  const prompts: RpcMessage[] = [];
  const sessionId = options.sessionId ?? "cursor-acp-session";
  onClientMessage = (process, message) => {
    messages.push(message);
    switch (message.method) {
      case "initialize":
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
        });
        break;
      case "authenticate":
        respond(process, message, {});
        break;
      case "session/new":
        respond(process, message, {
          sessionId,
          configOptions: options.modelOptions ? [{ id: "model", options: options.modelOptions }] : [],
        });
        break;
      case "session/load":
        if (options.loadError) fail(process, message, "Invalid params", { message: options.loadError });
        else respond(process, message, {
          sessionId,
          configOptions: options.modelOptions ? [{ id: "model", options: options.modelOptions }] : [],
        });
        break;
      case "session/set_config_option":
        respond(process, message, { configOptions: [] });
        break;
      case "session/prompt":
        prompts.push(message);
        break;
    }
  };
  return { messages, prompts };
}

function eventsFrom(lane: RuntimeLane): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  lane.on("runtime_event", (event) => events.push(event));
  lane.on("error", () => {});
  return events;
}

function completePrompt(process: FakeProcess, prompt: RpcMessage, stopReason = "end_turn"): void {
  respond(process, prompt, { stopReason });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  lastSpawn = null;
  spawned = [];
  onClientMessage = () => {};
  killEmitsExit = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CursorDriver persistent ACP transport", () => {
  it("spawns cursor-agent acp once with piped stdin and performs the strict handshake before prompt", async () => {
    const server = installServer();
    const driver = new CursorDriver();
    const lane = await driver.openLane(baseCtx());
    const events = eventsFrom(lane);

    await expect(lane.start({ text: "say hi" })).resolves.toEqual({
      ok: true,
      acceptedAs: "prompt",
      receipt: "cursor:acp:4",
    });

    expect(lastSpawn).toMatchObject({ args: ["acp"] });
    expect(lastSpawn!.args).not.toContain("--print");
    expect(lastSpawn!.args).not.toContain("--resume");
    expect(lastSpawn!.opts).not.toMatchObject({ stdin: "ignore" });
    expect(server.messages.map((message) => message.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(server.messages[0]!.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(server.prompts[0]!.params).toEqual({
      sessionId: "cursor-acp-session",
      prompt: [{ type: "text", text: "say hi" }],
    });
    expect(events).toEqual([{ kind: "session_init", sessionId: "cursor-acp-session" }]);
  });

  it("loads an ACP session without a fresh fallback and returns reset_required for an old incompatible id", async () => {
    killEmitsExit = true;
    const server = installServer({ sessionId: "legacy-print-id", loadError: "Session not found" });
    const lane = await new CursorDriver().openLane(baseCtx({ config: {
      sessionId: "legacy-print-id",
      runtimeConfig: { model: { kind: "default" } },
    } }));
    eventsFrom(lane);
    const exits: unknown[] = [];
    lane.on("exit", (exit) => exits.push(exit));

    await expect(lane.start({ text: "resume", sessionId: "legacy-print-id" })).resolves.toEqual({
      ok: false,
      reason: "reset_required",
      error: "Cursor session cannot be loaded through ACP; reset this agent to start a new ACP session",
    });
    expect(server.messages.map((message) => message.method)).toEqual([
      "initialize",
      "authenticate",
      "session/load",
    ]);
    expect(server.messages.some((message) => message.method === "session/new")).toBe(false);
    expect(exits).toEqual([]);
  });

  it.each([
    {
      name: "loadSession capability",
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "cursor_login" }],
      },
      error: "persistent session loading",
    },
    {
      name: "Cursor login auth method",
      initialize: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [],
      },
      error: "Cursor login authentication",
    },
  ])("fails the strict handshake closed without $name", async ({ initialize, error }) => {
    const messages: RpcMessage[] = [];
    onClientMessage = (process, message) => {
      messages.push(message);
      if (message.method === "initialize") respond(process, message, initialize);
    };
    const lane = await new CursorDriver().openLane(baseCtx());
    eventsFrom(lane);
    await expect(lane.start({ text: "strict" })).resolves.toMatchObject({
      ok: false,
      reason: "incompatible_configuration",
      error: expect.stringContaining(error),
    });
    expect(messages.map((message) => message.method)).toEqual(["initialize"]);
  });

  it("maps a configured model through ACP config options and fails closed when unavailable", async () => {
    const server = installServer({
      modelOptions: [{ value: "gpt-5.6-sol[reasoning=medium]", name: "gpt-5.6-sol" }],
    });
    const lane = await new CursorDriver().openLane(baseCtx({
      config: { runtimeConfig: { model: { kind: "named", name: "gpt-5.6-sol" } } },
    }));
    eventsFrom(lane);
    await expect(lane.start({ text: "configured" })).resolves.toMatchObject({ ok: true });
    expect(server.messages.find((message) => message.method === "session/set_config_option")?.params).toEqual({
      sessionId: "cursor-acp-session",
      configId: "model",
      value: "gpt-5.6-sol[reasoning=medium]",
    });

    installServer({ modelOptions: [{ value: "default[]", name: "Auto" }] });
    const incompatible = await new CursorDriver().openLane(baseCtx({
      config: { runtimeConfig: { model: { kind: "named", name: "missing-model" } } },
    }));
    eventsFrom(incompatible);
    await expect(incompatible.start({ text: "configured" })).resolves.toMatchObject({
      ok: false,
      reason: "incompatible_configuration",
      error: expect.stringContaining("missing-model"),
    });
  });

  it("keeps ten identical root turns on one ACP process and correlates terminals by request id", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    for (let turn = 0; turn < 10; turn += 1) {
      const admission = turn === 0
        ? await lane.start({ text: "same" })
        : await lane.send({ text: "same", mode: "idle" });
      expect(admission).toMatchObject({ ok: true, acceptedAs: "prompt" });
      const prompt = server.prompts[turn]!;
      completePrompt(spawned[0]!, prompt);
      await settle();
    }
    expect(spawned).toHaveLength(1);
    expect(server.messages.filter((message) => message.method === "session/new")).toHaveLength(1);
    expect(new Set(server.prompts.map((prompt) => prompt.id)).size).toBe(10);
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(10);
  });

  it("ignores duplicate and late prompt responses instead of ending the next turn", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "same" });
    const first = server.prompts[0]!;
    completePrompt(spawned[0]!, first);
    await settle();
    await lane.send({ text: "same", mode: "idle" });
    completePrompt(spawned[0]!, first);
    await settle();
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "runtime_diagnostic", severity: "warning" }));
    completePrompt(spawned[0]!, server.prompts[1]!);
    await settle();
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(2);
  });

  it("answers only allow_once permissions, fails unknown permission types closed, and cancels without killing", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "permissions" });
    const process = spawned[0]!;
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "cursor-acp-session",
        options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-2",
      method: "session/request_permission",
      params: {
        sessionId: "cursor-acp-session",
        options: [{ optionId: "allow-always", kind: "allow_always", name: "Allow always" }],
      },
    })}\n`);
    await expect(lane.interrupt({ requestId: "cancel-1" })).resolves.toBe(true);

    expect(server.messages).toContainEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });
    expect(server.messages).toContainEqual({
      jsonrpc: "2.0",
      id: "permission-2",
      result: { outcome: { outcome: "cancelled" } },
    });
    expect(server.messages).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "cursor-acp-session" },
    });
    expect(process.kill).not.toHaveBeenCalled();
    completePrompt(process, server.prompts[0]!, "cancelled");
    await settle();
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_end" }));
  });

  it("projects same-session updates, scrubs unknown updates, and ignores cross-session content", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "updates" });
    const process = spawned[0]!;
    const update = (sessionId: string, body: RpcMessage) => process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: body },
    })}\n`);
    update("cursor-acp-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    update("cursor-acp-session", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read",
      rawInput: { path: "README.md" },
    });
    update("cursor-acp-session", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Read",
      status: "completed",
    });
    update("cursor-acp-session", { sessionUpdate: "secret=value" });
    update("other-session", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "must-not-project" },
    });

    expect(events).toContainEqual({ kind: "text", text: "hello" });
    expect(events).toContainEqual({ kind: "tool_call", name: "Read", input: { path: "README.md" } });
    expect(events).toContainEqual({ kind: "tool_output", name: "Read" });
    expect(JSON.stringify(events)).not.toContain("secret=value");
    expect(JSON.stringify(events)).not.toContain("must-not-project");
  });

  it("fails malformed JSON and reports an unexpected ACP process exit", async () => {
    installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const errors: unknown[] = [];
    const exits: unknown[] = [];
    lane.on("error", (error) => errors.push(error));
    lane.on("exit", (exit) => exits.push(exit));
    lane.on("runtime_event", () => {});
    await lane.start({ text: "bad protocol" });
    spawned[0]!.stdout.write("{not-json}\n");
    expect(errors).toHaveLength(1);

    installServer();
    const crashed = await new CursorDriver().openLane(baseCtx());
    crashed.on("error", () => {});
    crashed.on("runtime_event", () => {});
    crashed.on("exit", (exit) => exits.push(exit));
    await crashed.start({ text: "crash" });
    spawned[1]!.finish(17, null);
    expect(exits).toContainEqual({ code: 17, signal: null, reason: "runtime_exit" });
  });
});
