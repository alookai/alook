import { NativeExecutionReader } from "./execution.js";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, SpawnedProcessHandle } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { createFakeAgentDriverHost } from "../../testing/fake-host.js";
import { createAgentDriverSdk } from "../../sdk.js";
import { AgyAcpLane } from "./acp-lane.js";
import { AgyDriver } from "./index.js";

type Message = { id?: number; method?: string; params?: Record<string, unknown> };
beforeEach(() => {
  vi.spyOn(NativeExecutionReader.prototype, "checkpoint").mockResolvedValue({ index: -1, executionId: null, lastStepIndex: -1 });
  vi.spyOn(NativeExecutionReader.prototype, "terminal").mockResolvedValue("success");
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { resume?: string; listedCwd?: string; confirm?: boolean; auth?: boolean; version?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agy-acp-"));
  roots.push(directory);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0, null); return true; }),
  });
  const process = child as unknown as SpawnedProcessHandle;
  const requests: Message[] = [];
  const prompts: Message[] = [];
  const model = { id: "model", type: "select", currentValue: "gemini-default", options: [
    { value: "gemini-default", name: "Default" }, { value: "gemini-flash", name: "Flash" },
  ] };
  const effort = { id: "thought_level", type: "select", currentValue: "low", options: [
    { value: "low", name: "Low" }, { value: "high", name: "High" },
  ] };
  const session = { sessionId: options.resume ?? "native", configOptions: [model, effort], models: {
    currentModelId: "gemini-default-low", availableModels: [{ modelId: "gemini-flash-high" }, { modelId: "gemini-flash-low" }],
  } };
  const respond = (request: Message, result: unknown) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  const fail = (request: Message, code: number, message: string) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code, message } }) + "\n");
  const update = (value: object, sessionId = session.sessionId) => child.stdout.write(JSON.stringify({
    jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value },
  }) + "\n");
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end)) as Message;
      buffer = buffer.slice(end + 1);
      requests.push(message);
      switch (message.method) {
        case "initialize": respond(message, { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: options.version ?? "1.4.12" },
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {}, close: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } }); break;
        case "session/new":
        case "session/resume": if (options.auth) fail(message, -32000, "Authentication required"); else respond(message, session); break;
        case "session/list": respond(message, { sessions: [{ sessionId: session.sessionId, cwd: options.listedCwd ?? directory }] }); break;
        case "session/set_config_option": {
          const option = message.params?.configId === "model" ? model : effort;
          option.currentValue = String(message.params?.value);
          respond(message, { configOptions: [model, effort] });
          if (options.confirm !== false) update({ sessionUpdate: "config_option_update", configOptions: [model, effort] });
          break;
        }
        case "session/prompt": prompts.push(message); break;
        case "session/cancel": break;
        default: if (message.id !== undefined) respond(message, {});
      }
    }
  });
  const ctx = fakeLaunchContext("agy", directory, {
    standingPrompt: "standing instructions", prompt: "first",
    config: { runtimeConfig: { model: { kind: "default" } } },
  });
  const lane = new AgyAcpLane({ spawn: async () => ({ process }) }, ctx, { handshakeTimeoutMs: 100 });
  const events: AdapterEvent[] = [];
  lane.on("runtime_event", (event) => events.push(event));
  return { directory, child, process, requests, prompts, respond, fail, update, ctx, lane, events };
}
const endings = (events: AdapterEvent[]) => events.filter((event) => event.kind === "turn_end");

describe("Antigravity CLI native ACP", () => {
  it("resumes the same physical directory through a symlink without allowing a different directory", async () => {
    const f = fixture({ resume: "saved" });
    const alias = join(f.directory, "alias");
    symlinkSync(f.directory, alias, "junction");
    const lane = new AgyAcpLane({ spawn: async () => ({ process: f.process }) }, { ...f.ctx, workingDirectory: alias });
    try {
      expect(await lane.start({ text: "resumed", sessionId: "saved" })).toMatchObject({ ok: true });
      expect(f.requests.filter(request => request.method === "session/resume")).toHaveLength(1);
    } finally { await lane.stop(); }
  });

  it.each([
    { version: "1.4.12", input: 25, output: 5 },
    { version: "1.5.9", input: 21, output: 8 },
  ])("normalizes independently observed usage profile $version once", async ({ version, input, output }) => {
    const f = fixture({ version });
    try {
      await f.lane.start({ text: "first" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn", usage: { inputTokens: input, outputTokens: output, cachedReadTokens: 4, thoughtTokens: 3 } });
      expect(f.events.filter(event => event.kind === "telemetry" && event.name === "token_usage")).toMatchObject([{ usage: { input: 21, output: 8, cache: 4 } }]);
      expect(endings(f.events)).toMatchObject([{ outcome: "success" }]);
    } finally { await f.lane.stop(); }
  });

  it("keeps unknown-version usage unavailable without changing verified execution success", async () => {
    const f = fixture({ version: "1.5.10" });
    try {
      await f.lane.start({ text: "first" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn", usage: { inputTokens: 25, outputTokens: 5, cachedReadTokens: 4, thoughtTokens: 3 } });
      expect(f.events.filter(event => event.kind === "telemetry" && event.name === "token_usage")).toHaveLength(0);
      expect(f.events).toContainEqual({ kind: "telemetry", name: "token_usage_status", source: "agy.acp", status: "unavailable" });
      expect(endings(f.events)).toMatchObject([{ outcome: "success" }]);
    } finally { await f.lane.stop(); }
  });

  it.each(["failed", "unreadable"])("does not convert native end_turn and positive usage into success: %s", async (mode) => {
    const f = fixture();
    if (mode === "failed") vi.mocked(NativeExecutionReader.prototype.terminal).mockResolvedValue("failed");
    else vi.mocked(NativeExecutionReader.prototype.terminal).mockRejectedValue(new Error("private database detail"));
    try {
      await f.lane.start({ text: "first" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn", usage: { inputTokens: 25, outputTokens: 5 } });
      expect(endings(f.events)).toMatchObject([{ outcome: "failed", stopReason: "failed" }]);
      expect(JSON.stringify(f.events)).not.toContain("private database detail");
    } finally { await f.lane.stop(); }
  });

  it("fences a pending terminal read after stop and refuses late steering without accepting it", async () => {
    const f = fixture();
    let release!: (outcome: "success") => void;
    vi.mocked(NativeExecutionReader.prototype.terminal).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await f.lane.start({ text: "first" });
    await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
    expect(await f.lane.send({ text: "late", mode: "busy" })).toMatchObject({ ok: false, reason: "runtime_busy" });
    expect(f.prompts).toHaveLength(1);
    let stopped = false;
    const stopping = f.lane.stop({ forceAfterMs: 0 }).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release("success");
    await stopping;
    await Promise.resolve();
    expect(endings(f.events)).toHaveLength(0);
  });

  it("cleans up a start whose native execution checkpoint cannot be read", async () => {
    const f = fixture();
    vi.mocked(NativeExecutionReader.prototype.checkpoint).mockRejectedValue(new Error("private"));
    expect(await f.lane.start({ text: "first" })).toMatchObject({ ok: false, reason: "incompatible_configuration" });
    expect(f.prompts).toHaveLength(0);
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it("preserves a late public SDK command once while native terminal verification is pending", async () => {
    const f = fixture();
    let release!: (outcome: "success") => void;
    vi.mocked(NativeExecutionReader.prototype.terminal).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    vi.spyOn(AgyDriver.prototype, "spawn").mockResolvedValue({ process: f.process, stateHome: f.directory });
    const host = createFakeAgentDriverHost();
    const opened = await createAgentDriverSdk({ host }).open({ backend: "agy", config: { model: { kind: "default" } },
      launch: { workingDirectory: f.directory, instructions: { format: "markdown", content: "standing" }, launchId: "boundary" } });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    const events: { type: string }[] = [];
    const collecting = (async () => { for await (const event of session.events) events.push(event); })();
    try {
      await session.start({ id: "first", kind: "user", text: "first" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
      expect(await session.send({ id: "late", kind: "user", text: "late" })).toMatchObject({ status: "queued" });
      expect(f.prompts).toHaveLength(1);
      release("success");
      await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
      expect(f.prompts[1]!.params?.prompt).toEqual([{ type: "text", text: "late" }]);
      await f.respond(f.prompts[1]!, { stopReason: "end_turn" });
      await vi.waitFor(() => expect(events.filter(event => event.type === "turn_completed")).toHaveLength(2));
      expect(f.prompts).toHaveLength(2);
      expect(session.snapshot().state).toBe("idle");
    } finally { await session.stop({ reason: "shutdown", forceAfterMs: 0 }); await session.closed; await collecting; }
    expect(host.releases).toHaveLength(1);
  });

  it.each(["original-first", "steer-first"])("keeps one root until all native prompt responses settle: %s", async (order) => {
    const f = fixture();
    try {
      const first = await f.lane.start({ text: "first" });
      expect(first).toMatchObject({ ok: true, acceptedAs: "prompt" });
      const second = await f.lane.send({ text: "second", mode: "busy" });
      expect(second).toMatchObject({ ok: true, acceptedAs: "steer" });
      expect(f.prompts).toHaveLength(2);
      const ordered = order === "original-first" ? f.prompts : [...f.prompts].reverse();
      await f.respond(ordered[0]!, { stopReason: "end_turn" });
      expect(endings(f.events)).toHaveLength(0);
      f.update({ sessionUpdate: "tool_call", toolCallId: "tool", name: "run_command", title: "Run command", status: "in_progress", rawInput: { CommandLine: "echo hi" } });
      f.update({ sessionUpdate: "tool_call_update", toolCallId: "tool", title: "Run command", status: "completed" });
      f.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second reply" } });
      await f.respond(ordered[1]!, { stopReason: "end_turn" });
      expect(endings(f.events)).toEqual([{ kind: "turn_end", sessionId: "native", turnOwner: first.ok ? first.receipt : "", outcome: "success", stopReason: "end_turn" }]);
      await f.respond(ordered[1]!, { stopReason: "cancelled" });
      expect(endings(f.events)).toHaveLength(1);
      expect(f.events.filter((event) => event.kind === "tool_call")).toMatchObject([{ name: "run_command" }]);
      expect(f.events.filter((event) => event.kind === "tool_output")).toMatchObject([{ name: "run_command", outcome: "success" }]);
    } finally { await f.lane.stop({ forceAfterMs: 0 }); }
  });

  it.each(["original-first", "refusal-first"])("returns only a refused steer without changing root success: %s", async (order) => {
    const f = fixture();
    try {
      await f.lane.start({ text: "first" });
      const inputs = [{ commandId: "notice", attemptId: "attempt" }];
      await f.lane.send({ text: "notice", mode: "busy", inputs });
      if (order === "original-first") await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
      await f.fail(f.prompts[1]!, -32602, "invalid params");
      if (order === "refusal-first") {
        expect(endings(f.events)).toHaveLength(0);
        await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
      }
      expect(f.events).toContainEqual({ kind: "input_returned", inputs, evidence: "explicitly_rejected", reason: "agy.rpc.-32602" });
      expect(endings(f.events)).toMatchObject([{ outcome: "success" }]);
    } finally { await f.lane.stop(); }
  });

  it("keeps an accepted replacement worker error as turn failure after the earlier response", async () => {
    const f = fixture();
    try {
      await f.lane.start({ text: "first" });
      await f.lane.send({ text: "notice", mode: "busy" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
      await f.fail(f.prompts[1]!, -32603, "worker failed");
      expect(endings(f.events)).toMatchObject([{ outcome: "failed" }]);
      expect(f.events.some((event) => event.kind === "input_returned")).toBe(false);
    } finally { await f.lane.stop(); }
  });

  it.each(["worker-error", "missing-result"])("does not turn an unproven steer failure into rejection while the original is pending: %s", async (failure) => {
    const f = fixture();
    try {
      await f.lane.start({ text: "first" });
      await f.lane.send({ text: "second", mode: "busy" });
      if (failure === "worker-error") await f.fail(f.prompts[1]!, -32603, "worker failed");
      else f.child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: f.prompts[1]!.id }) + "\n");
      expect(endings(f.events)).toHaveLength(0);
      expect(f.events.some((event) => event.kind === "input_returned")).toBe(false);
      await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
      expect(endings(f.events)).toMatchObject([{ outcome: "failed" }]);
    } finally { await f.lane.stop(); }
  });

  it("keeps an earlier worker failure even if the latest prompt responds successfully", async () => {
    const f = fixture();
    try {
      await f.lane.start({ text: "first" });
      await f.lane.send({ text: "second", mode: "busy" });
      await f.fail(f.prompts[0]!, -32603, "worker failed");
      await f.respond(f.prompts[1]!, { stopReason: "end_turn" });
      expect(endings(f.events)).toMatchObject([{ outcome: "failed" }]);
    } finally { await f.lane.stop(); }
  });

  it("correlates native user input and ignores foreign-session updates", async () => {
    const f = fixture();
    try {
      const inputs = [{ commandId: "notice", attemptId: "attempt" }];
      await f.lane.start({ text: "first" });
      await f.lane.send({ text: "notice", mode: "busy", inputs });
      f.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "notice" } }, "child");
      f.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } }, "child");
      expect(f.events.some((event) => event.kind === "input_observed")).toBe(false);
      f.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "notice" } });
      expect(f.events).toContainEqual({ kind: "input_observed", inputs, evidence: "user_message" });
    } finally { await f.lane.stop(); }
  });

  it("uses native model and thought-level selectors, including an existing legacy model id", async () => {
    const f = fixture();
    const lane = new AgyAcpLane({ spawn: async () => ({ process: f.process }) }, {
      ...f.ctx, config: { runtimeConfig: { model: { kind: "named", name: "gemini-flash-high" }, reasoningEffort: "low" } },
    }, { handshakeTimeoutMs: 100 });
    try {
      expect(await lane.start({ text: "first" })).toMatchObject({ ok: true });
      expect(f.requests.filter((message) => message.method === "session/set_config_option").map((message) => message.params)).toEqual([
        { sessionId: "native", configId: "model", value: "gemini-flash" },
        { sessionId: "native", configId: "thought_level", value: "low" },
      ]);
      expect(f.prompts[0]?.params?.prompt).toEqual([{ type: "text", text: "first" }]);
      expect(f.requests.find((message) => message.method === "session/new")?.params?._meta).toEqual({ antigravity: { systemPrompt: { append: "standing instructions" } } });
    } finally { await lane.stop(); }
  });

  it("refuses a configuration with no matching native notification before sending a prompt", async () => {
    const f = fixture({ confirm: false });
    const lane = new AgyAcpLane({ spawn: async () => ({ process: f.process }) }, {
      ...f.ctx, config: { runtimeConfig: { model: { kind: "named", name: "gemini-flash" } } },
    }, { handshakeTimeoutMs: 20 });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      expect(await lane.start({ text: "first" })).toMatchObject({ ok: false, reason: "incompatible_configuration" });
      expect(f.prompts).toHaveLength(0);
      expect(f.child.kill).toHaveBeenCalled();
    } finally { clearTimeout(keepAlive); await lane.stop(); }
  });

  it("verifies the saved directory and uses native resume without replay", async () => {
    const f = fixture({ resume: "saved" });
    try {
      expect(await f.lane.start({ text: "continue", sessionId: "saved" })).toMatchObject({ ok: true });
      expect(f.requests.map((message) => message.method)).toEqual(["initialize", "session/list", "session/resume", "session/prompt"]);
      expect(f.requests.find((message) => message.method === "session/resume")?.params?._meta).toEqual({ antigravity: { systemPrompt: { append: "standing instructions" } } });
    } finally { await f.lane.stop(); }
  });

  it("rejects a saved directory mismatch without loading or replacing the session", async () => {
    const f = fixture({ resume: "saved", listedCwd: "/different" });
    try {
      expect(await f.lane.start({ text: "continue", sessionId: "saved" })).toMatchObject({ ok: false, reason: "reset_required" });
      expect(f.requests.some((message) => message.method === "session/resume" || message.method === "session/new")).toBe(false);
    } finally { await f.lane.stop(); }
  });

  it.each(["original", "latest", "both"])("settles one loop usage from %s response and resets at the next turn", async (position) => {
    const f = fixture();
    const usage = { inputTokens: 50, outputTokens: 10, cachedReadTokens: 8, cachedWriteTokens: 0, thoughtTokens: 6, totalTokens: 66 };
    try {
      await f.lane.start({ text: "first" });
      await f.lane.send({ text: "second", mode: "busy" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn", ...(position !== "latest" ? { usage } : {}) });
      expect(f.events.some((event) => event.kind === "telemetry" && event.name === "token_usage")).toBe(false);
      await f.respond(f.prompts[1]!, { stopReason: "end_turn", ...(position !== "original" ? { usage } : {}) });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn", usage });
      await f.lane.send({ text: "idle", mode: "idle" });
      await f.respond(f.prompts[2]!, { stopReason: "end_turn", usage: { inputTokens: 25, outputTokens: 5, cachedReadTokens: 4, cachedWriteTokens: 0, thoughtTokens: 3 } });
      const samples = f.events.filter((event) => event.kind === "telemetry" && event.name === "token_usage");
      expect(samples).toMatchObject([{ usage: { input: 42, output: 16, cache: 8 } }, { usage: { input: 21, output: 8, cache: 4 } }]);
      const identities = samples.map((event) => event.kind === "telemetry" && event.name === "token_usage" ? event.identity : undefined);
      expect(identities[0]?.source).toBe(identities[1]?.source);
      expect(identities[0]?.index).not.toBe(identities[1]?.index);
    } finally { await f.lane.stop(); }
  });

  it("reports missing counts as unknown instead of zero", async () => {
    const f = fixture();
    try {
      await f.lane.start({ text: "first" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn", usage: { inputTokens: -1, outputTokens: 3, thoughtTokens: 2 } });
      expect(f.events).toContainEqual(expect.objectContaining({ kind: "telemetry", name: "token_usage", usage: { input: null, output: 5, cache: null } }));
    } finally { await f.lane.stop(); }
  });

  it("returns a sign-in error and cleans startup without issuing an inference", async () => {
    const f = fixture({ auth: true });
    try {
      expect(await f.lane.start({ text: "first" })).toMatchObject({ ok: false, reason: "authentication" });
      expect(f.prompts).toHaveLength(0);
      expect(f.child.kill).toHaveBeenCalledTimes(1);
    } finally { await f.lane.stop(); }
  });

  it("cancels an active loop on the native session without opening a new process", async () => {
    const f = fixture();
    try {
      await f.lane.start({ text: "first" });
      await f.lane.send({ text: "second", mode: "busy" });
      expect(await f.lane.interrupt({ requestId: "cancel", reason: "user" })).toBe(true);
      expect(f.requests.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "native" } });
      for (const prompt of f.prompts) await f.respond(prompt, { stopReason: "cancelled" });
      expect(endings(f.events)).toMatchObject([{ outcome: "interrupted", pendingContent: "discard" }]);
      expect(await f.lane.interrupt({ requestId: "idle", reason: "user" })).toBe(false);
    } finally { await f.lane.stop(); }
  });

  it("runs busy steering and the next idle turn through the public SDK with one process", async () => {
    const f = fixture();
    const spawn = vi.spyOn(AgyDriver.prototype, "spawn").mockResolvedValue({ process: f.process, stateHome: f.directory });
    const host = createFakeAgentDriverHost();
    const opened = await createAgentDriverSdk({ host }).open({
      backend: "agy", config: { model: { kind: "default" } },
      launch: { workingDirectory: f.directory, instructions: { format: "markdown", content: "standing" }, launchId: "public-agy" },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.session;
    const events: { type: string }[] = [];
    const collecting = (async () => { for await (const event of session.events) events.push(event); })();
    try {
      expect(await session.start({ id: "first", kind: "user", text: "first" })).toMatchObject({ status: "accepted" });
      expect(await session.send({ id: "second", kind: "user", text: "second" })).toMatchObject({ status: "accepted", delivery: "steer" });
      await f.respond(f.prompts[0]!, { stopReason: "end_turn" });
      expect(session.snapshot().state).toBe("working");
      await f.respond(f.prompts[1]!, { stopReason: "end_turn" });
      await vi.waitFor(() => expect(session.snapshot().state).toBe("idle"));
      expect(await session.send({ id: "third", kind: "user", text: "third" })).toMatchObject({ status: "accepted" });
      await f.respond(f.prompts[2]!, { stopReason: "end_turn" });
      await vi.waitFor(() => expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(2));
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await session.stop({ reason: "shutdown", forceAfterMs: 0 }); await session.closed; await collecting; }
    expect(host.releases).toHaveLength(1);
  });
});
