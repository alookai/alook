import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, AdapterLaunchContext, RuntimeLane, SpawnedProcessHandle } from "../../internal/adapter.js";
import { createAgentDriverSdk } from "../../sdk.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";
import { CursorDriver } from "./index.js";

type RpcMessage = Record<string, unknown>;
type FakeProcess = SpawnedProcessHandle & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  emit(event: string, ...args: unknown[]): boolean;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
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

  it("settles a prompt synchronously before dropping a later update in the same stdout chunk", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "wire order" });
    const process = spawned[0]!;
    const prompt = server.prompts[0]!;
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "cursor-acp-session",
        update: { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Old tool" },
      },
    })}\n`);
    process.stdout.write([
      JSON.stringify({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "cursor-acp-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "must-not-project" },
          },
        },
      }),
      "",
    ].join("\n"));

    expect(events.findIndex((event) => event.kind === "turn_end")).toBeGreaterThanOrEqual(0);
    expect(events.some((event) => event.kind === "text")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "runtime_diagnostic",
      severity: "warning",
      message: "Cursor ACP emitted a session update without an active prompt",
    });
    await expect(lane.send({ text: "next", mode: "idle" })).resolves.toMatchObject({ ok: true });
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "cursor-acp-session",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "old-tool",
          title: "Old tool",
          status: "completed",
        },
      },
    })}\n`);
    expect(events.some((event) => event.kind === "tool_output")).toBe(false);
  });

  it("drops a next-tick same-session update after the prompt terminal", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "late update" });
    completePrompt(spawned[0]!, server.prompts[0]!);
    await settle();
    spawned[0]!.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "cursor-acp-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "must-not-project" },
        },
      },
    })}\n`);

    expect(events.some((event) => event.kind === "text")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "runtime_diagnostic",
      message: "Cursor ACP emitted a session update without an active prompt",
    }));
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
        options: [{ optionId: "vendor-choice-7", kind: "allow_once", name: "Allow once" }],
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
      result: { outcome: { outcome: "selected", optionId: "vendor-choice-7" } },
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
    expect(JSON.stringify(events)).not.toContain("vendor-choice-7");
    completePrompt(process, server.prompts[0]!, "cancelled");
    await settle();
    expect(events).toContainEqual(expect.objectContaining({ kind: "turn_end" }));
  });

  it("cancels permissions outside the active root prompt, including after a same-chunk terminal", async () => {
    const messages: RpcMessage[] = [];
    const prompts: RpcMessage[] = [];
    onClientMessage = (process, message) => {
      messages.push(message);
      if (message.method === "initialize") {
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cursor_login" }],
        });
      } else if (message.method === "authenticate") {
        respond(process, message, {});
      } else if (message.method === "session/new") {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: "permission-before-prompt",
          method: "session/request_permission",
          params: {
            sessionId: "cursor-acp-session",
            options: [{ optionId: "allow-once", kind: "allow_once" }],
          },
        })}\n`);
        respond(process, message, { sessionId: "cursor-acp-session", configOptions: [] });
      } else if (message.method === "session/prompt") {
        prompts.push(message);
      }
    };
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "permission fence" });
    const process = spawned[0]!;

    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-cross-session",
      method: "session/request_permission",
      params: {
        sessionId: "other-session",
        options: [{ optionId: "allow-once", kind: "allow_once" }],
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "permission-unknown-type",
      method: "session/request_permission",
      params: {
        sessionId: "cursor-acp-session",
        options: [{ optionId: "allow-always", kind: "allow_always" }],
      },
    })}\n`);
    process.stdout.write([
      JSON.stringify({ jsonrpc: "2.0", id: prompts[0]!.id, result: { stopReason: "end_turn" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: "permission-after-terminal",
        method: "session/request_permission",
        params: {
          sessionId: "cursor-acp-session",
          options: [{ optionId: "allow-once", kind: "allow_once" }],
        },
      }),
      "",
    ].join("\n"));

    for (const id of [
      "permission-before-prompt",
      "permission-cross-session",
      "permission-unknown-type",
      "permission-after-terminal",
    ]) {
      expect(messages).toContainEqual({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
  });

  it("rejects malformed allow_once option ids while a root prompt is active", async () => {
    const server = installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const events = eventsFrom(lane);
    await lane.start({ text: "malformed permission ids" });
    const process = spawned[0]!;
    const malformed = [
      { id: "permission-missing-id", option: { kind: "allow_once" } },
      { id: "permission-empty-id", option: { optionId: "", kind: "allow_once" } },
      { id: "permission-whitespace-id", option: { optionId: "   ", kind: "allow_once" } },
      { id: "permission-non-string-id", option: { optionId: 7, kind: "allow_once" } },
    ];
    for (const entry of malformed) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: entry.id,
        method: "session/request_permission",
        params: { sessionId: "cursor-acp-session", options: [entry.option] },
      })}\n`);
    }

    for (const entry of malformed) {
      expect(server.messages).toContainEqual({
        jsonrpc: "2.0",
        id: entry.id,
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    expect(events).toHaveLength(malformed.length + 1);
    expect(events.slice(1)).toEqual(malformed.map(() => expect.objectContaining({
      kind: "runtime_diagnostic",
      severity: "error",
      message: "Cursor ACP permission request was not allowed for the active prompt",
    })));
  });

  it("fences a stop racing the final handshake response before ready or prompt admission", async () => {
    const messages: RpcMessage[] = [];
    let lane!: RuntimeLane;
    onClientMessage = (process, message) => {
      messages.push(message);
      if (message.method === "initialize") {
        respond(process, message, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: "cursor_login" }],
        });
      } else if (message.method === "authenticate") {
        respond(process, message, {});
      } else if (message.method === "session/new") {
        respond(process, message, { sessionId: "cursor-acp-session", configOptions: [] });
        void lane.stop({ reason: "race", forceAfterMs: 0 });
      }
    };
    lane = await new CursorDriver().openLane(baseCtx());
    eventsFrom(lane);

    await expect(lane.start({ text: "must not admit" })).rejects.toThrow("start was cancelled");
    expect(messages.some((message) => message.method === "session/prompt")).toBe(false);
    expect(spawned[0]!.kill).toHaveBeenCalledOnce();
  });

  it("keeps a pre-spawn stop durable and terminates the eventual process exactly once", async () => {
    const spawnGate = deferred<{ process: FakeProcess }>();
    const driver = new CursorDriver();
    vi.spyOn(driver, "spawn").mockReturnValue(spawnGate.promise);
    const lane = await driver.openLane(baseCtx());
    eventsFrom(lane);
    const starting = lane.start({ text: "must not admit" });
    await settle();
    const stopping = lane.stop({ reason: "race", forceAfterMs: 0 });
    const process = fakeProcess();
    spawnGate.resolve({ process });

    await expect(stopping).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow("start was cancelled");
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("keeps the public session idle when a late Cursor update follows the terminal", async () => {
    const server = installServer();
    const host = createFakeAgentDriverHost();
    const workingDirectory = mkdtempSync(join(tmpdir(), "cursor-acp-public-test-"));
    temporaryDirectories.push(workingDirectory);
    const opened = await createAgentDriverSdk({ host }).open({
      backend: "cursor",
      config: { model: { kind: "default" } },
      launch: {
        workingDirectory,
        instructions: { format: "markdown", content: "" },
        launchId: "cursor-acp-public-late-update",
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await expect(opened.session.start({ id: "one", kind: "user", text: "public" }))
      .resolves.toMatchObject({ status: "accepted" });
    completePrompt(spawned[0]!, server.prompts[0]!);
    await settle();
    spawned[0]!.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "cursor-acp-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "must-not-resurrect" },
        },
      },
    })}\n`);
    await settle();

    expect(opened.session.snapshot()).toMatchObject({ state: "idle", activeTurn: undefined });
    await opened.session.stop({ reason: "shutdown", forceAfterMs: 0 });
  });

  it("closes an active public session on process error without exit and deduplicates a later exit", async () => {
    installServer();
    const host = createFakeAgentDriverHost();
    const workingDirectory = mkdtempSync(join(tmpdir(), "cursor-acp-public-error-test-"));
    temporaryDirectories.push(workingDirectory);
    const opened = await createAgentDriverSdk({ host }).open({
      backend: "cursor",
      config: { model: { kind: "default" } },
      launch: {
        workingDirectory,
        instructions: { format: "markdown", content: "" },
        launchId: "cursor-acp-public-error-only",
      },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    await expect(opened.session.start({ id: "one", kind: "user", text: "public" }))
      .resolves.toMatchObject({ status: "accepted" });
    const process = spawned[0]!;

    process.emit("error", new Error("EIO"));
    process.emit("error", new Error("duplicate"));

    await expect(opened.session.closed).resolves.toMatchObject({
      outcome: "crashed",
      exitCode: null,
      signal: null,
    });
    expect(process.kill).toHaveBeenCalledOnce();
    expect(host.releases).toHaveLength(1);

    process.finish(17, null);
    process.emit("error", new Error("late"));
    await settle();
    expect(process.kill).toHaveBeenCalledOnce();
    expect(host.releases).toHaveLength(1);
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

  it("turns an activated process error into one killed crash exit", async () => {
    installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const errors: Error[] = [];
    const exits: unknown[] = [];
    lane.on("error", (error) => errors.push(error instanceof Error ? error : new Error(String(error))));
    lane.on("runtime_event", () => {});
    lane.on("exit", (exit) => exits.push(exit));
    await lane.start({ text: "crash" });
    const process = spawned[0]!;

    process.emit("error", new Error("EIO"));
    process.emit("error", new Error("duplicate"));
    await settle();

    expect(errors).toEqual([new Error("EIO")]);
    expect(exits).toEqual([{ code: null, signal: null, reason: "runtime_exit" }]);
    expect(process.kill).toHaveBeenCalledOnce();

    process.finish(17, null);
    process.emit("error", new Error("late"));
    expect(exits).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("ignores a process error after an authoritative exit", async () => {
    installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const errors: Error[] = [];
    const exits: unknown[] = [];
    lane.on("error", (error) => errors.push(error instanceof Error ? error : new Error(String(error))));
    lane.on("runtime_event", () => {});
    lane.on("exit", (exit) => exits.push(exit));
    await lane.start({ text: "crash" });
    const process = spawned[0]!;

    process.finish(17, null);
    process.emit("error", new Error("late"));

    expect(exits).toEqual([{ code: 17, signal: null, reason: "runtime_exit" }]);
    expect(errors).toEqual([]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("keeps requested stop ownership when the process errors during cleanup", async () => {
    installServer();
    const lane = await new CursorDriver().openLane(baseCtx());
    const errors: Error[] = [];
    const exits: unknown[] = [];
    lane.on("error", (error) => errors.push(error instanceof Error ? error : new Error(String(error))));
    lane.on("runtime_event", () => {});
    lane.on("exit", (exit) => exits.push(exit));
    await lane.start({ text: "stop" });
    const process = spawned[0]!;

    const stopping = lane.stop({ reason: "test", forceAfterMs: 0 });
    process.emit("error", new Error("EIO"));
    await stopping;

    expect(errors).toEqual([new Error("EIO")]);
    expect(exits).toEqual([]);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("keeps a handshake process error under failed-start ownership", async () => {
    const messages: RpcMessage[] = [];
    onClientMessage = (_process, message) => { messages.push(message); };
    const lane = await new CursorDriver().openLane(baseCtx());
    const errors: Error[] = [];
    const exits: unknown[] = [];
    lane.on("error", (error) => errors.push(error instanceof Error ? error : new Error(String(error))));
    lane.on("runtime_event", () => {});
    lane.on("exit", (exit) => exits.push(exit));
    const starting = lane.start({ text: "must not admit" });
    await vi.waitFor(() => expect(messages.map((message) => message.method)).toEqual(["initialize"]));
    const process = spawned[0]!;

    process.emit("error", new Error("EIO"));

    await expect(starting).rejects.toThrow("EIO");
    expect(errors).toEqual([new Error("EIO")]);
    expect(exits).toEqual([]);
    expect(process.kill).toHaveBeenCalledOnce();
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
