import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent, SpawnedProcessHandle } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { AntigravityAcpLane } from "./acp-lane.js";
import { antigravitySpawnSpec, probeAntigravity } from "./probe.js";

type Message = { id: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { authError?: boolean; loadId?: string; loadError?: boolean; incompatible?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "alook-antigravity-test-"));
  dirs.push(directory);
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => { proc.signalCode = signal; proc.emit("exit", null, signal); return true; }),
  });
  const messages: Message[] = [];
  const emit = (value: unknown) => proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value as object })}\n`);
  proc.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const message = JSON.parse(line) as Message;
      messages.push(message);
      if (message.method === "initialize") emit({ id: message.id, result: {
        protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.3.0" },
        agentCapabilities: { loadSession: !options.incompatible },
      } });
      if (message.method === "session/new" || message.method === "session/load") {
        if (options.authError) emit({ id: message.id, error: { code: -32000, message: "Authentication required" } });
        else if (options.loadError) emit({ id: message.id, error: { code: -32000, message: "Session not found" } });
        else emit({ id: message.id, result: {
          sessionId: options.loadId ?? "native-session", models: { availableModels: [{ modelId: "test-model" }] },
        } });
      }
      if (message.method === "session/set_model") emit({ id: message.id, result: {} });
    }
  });
  const ctx = fakeLaunchContext("antigravity", directory, {
    standingPrompt: "standing-instruction-only-marker", config: { runtimeConfig: { model: { kind: "default" } } },
  });
  const spawn = vi.fn(async () => ({ process: proc as SpawnedProcessHandle }));
  const lane = new AntigravityAcpLane({ spawn }, ctx, { handshakeTimeoutMs: 100 });
  const events: AdapterEvent[] = [];
  lane.on("runtime_event", (event) => events.push(event));
  lane.on("error", () => {});
  const prompts = () => messages.filter((message) => message.method === "session/prompt");
  const update = (update: unknown, sessionId = "native-session") => emit({ method: "session/update", params: { sessionId, update } });
  return { ctx, proc, messages, spawn, lane, events, emit, prompts, update };
}

describe("Antigravity native ACP", () => {
  it("reuses one process and exact session across prompts, delivering current instructions once", async () => {
    const h = setup();
    await expect(h.lane.start({ text: "first" })).resolves.toMatchObject({ ok: true, acceptedAs: "prompt" });
    expect(h.prompts()[0]?.params).toMatchObject({ sessionId: "native-session", prompt: [{ type: "text", text: "standing-instruction-only-marker\n\nfirst" }] });
    await expect(h.lane.send({ text: "busy", mode: "busy" })).resolves.toMatchObject({ ok: false, reason: "runtime_busy" });
    expect(h.prompts()).toHaveLength(1);
    h.emit({ id: h.prompts()[0]!.id, result: { stopReason: "end_turn" } });
    await expect(h.lane.send({ text: "second", mode: "idle" })).resolves.toMatchObject({ ok: true });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.messages.filter((message) => message.method === "session/new")).toHaveLength(1);
    expect(h.prompts()[1]?.params).toEqual({ sessionId: "native-session", prompt: [{ type: "text", text: "second" }] });
    await h.lane.stop();
    expect(h.proc.kill).toHaveBeenCalledTimes(1);
    await h.lane.stop();
    expect(h.proc.kill).toHaveBeenCalledTimes(1);
  });

  it("loads only the requested session and refuses a substituted or missing session", async () => {
    for (const options of [{ loadId: "saved" }, { loadId: "other" }, { loadError: true }]) {
      const h = setup(options);
      const result = await h.lane.start({ text: "resume", sessionId: "saved" });
      expect(result).toMatchObject(options.loadId === "saved" ? { ok: true } : { ok: false, reason: "reset_required" });
      expect(h.messages.find((message) => message.method === "session/load")?.params).toMatchObject({ sessionId: "saved" });
      expect(h.messages.some((message) => message.method === "session/new")).toBe(false);
      await h.lane.stop();
    }
  });

  it.each([
    [{ authError: true }, "authentication"], [{ incompatible: true }, "incompatible_configuration"],
  ] as const)("rejects startup and cleans up for %j", async (options, reason) => {
    const h = setup(options);
    await expect(h.lane.start({ text: "first" })).resolves.toMatchObject({ ok: false, reason });
    expect(h.prompts()).toHaveLength(0);
    expect(h.proc.kill).toHaveBeenCalledTimes(1);
  });

  it("only the matching root RPC response ends a turn; updates and old terminals cannot", async () => {
    const h = setup();
    await h.lane.start({ text: "first" });
    const first = h.prompts()[0]!.id;
    h.emit({ id: 999, result: { stopReason: "end_turn" } });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "wrong" } }, "child-session");
    expect(h.events.filter((event) => event.kind === "turn_end")).toHaveLength(0);
    h.emit({ id: first, result: { stopReason: "end_turn" } });
    await h.lane.send({ text: "second", mode: "idle" });
    h.emit({ id: first, result: { stopReason: "end_turn" } });
    expect(h.events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
    h.emit({ id: h.prompts()[1]!.id, result: { stopReason: "end_turn" } });
    expect(h.events.filter((event) => event.kind === "turn_end")).toHaveLength(2);
    expect(h.events.some((event) => event.kind === "assistant_message_delta" && event.text === "wrong")).toBe(false);
    await h.lane.stop();
  });

  it("tracks tool ownership and permits only the active session's allow-once requests", async () => {
    const h = setup();
    await h.lane.start({ text: "run pwd" });
    h.update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "shell", rawInput: { command: "pwd" } });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
    expect(h.events.filter((event) => event.kind === "tool_call")).toMatchObject([{ callId: "tool-1" }]);
    expect(h.events.filter((event) => event.kind === "tool_output")).toMatchObject([{ callId: "tool-1" }]);
    for (const sessionId of ["native-session", "other"]) {
      h.emit({ id: 999, method: "session/request_permission", params: {
        sessionId, options: [{ kind: "allow_once", optionId: "once" }],
      } });
      expect(h.messages.at(-1)?.result).toEqual({ outcome: sessionId === "native-session"
        ? { outcome: "selected", optionId: "once" } : { outcome: "cancelled" } });
    }
    await h.lane.interrupt({});
    expect(h.messages.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "native-session" } });
    await h.lane.stop();
  });

  it("denies permissions after cancel but waits for the matching terminal and permits the next turn", async () => {
    const h = setup();
    await h.lane.start({ text: "first" });
    await h.lane.interrupt({});
    const request = { id: 900, method: "session/request_permission", params: {
      sessionId: "native-session", options: [{ kind: "allow_once", optionId: "once" }],
    } };
    h.emit(request);
    expect(h.messages.at(-1)?.result).toEqual({ outcome: { outcome: "cancelled" } });
    expect(h.events.filter((event) => event.kind === "turn_end")).toHaveLength(0);
    await expect(h.lane.send({ text: "early", mode: "idle" })).resolves.toMatchObject({ ok: false, reason: "runtime_busy" });
    h.emit({ id: h.prompts()[0]!.id, result: { stopReason: "cancelled" } });
    expect(h.events.filter((event) => event.kind === "turn_end")).toHaveLength(1);
    await h.lane.send({ text: "second", mode: "idle" });
    h.emit(request);
    expect(h.messages.at(-1)?.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    await h.lane.stop();
  });

  it.each(["completed", "failed"])("settles an initially %s tool once, including repeated updates", async (status) => {
    const h = setup();
    await h.lane.start({ text: "first" });
    const call = { sessionUpdate: "tool_call", toolCallId: "already-done", title: "read", status };
    h.update(call);
    h.update(call);
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "already-done", status });
    expect(h.events.filter((event) => event.kind === "tool_call")).toMatchObject([{ callId: "already-done" }]);
    expect(h.events.filter((event) => event.kind === "tool_output")).toMatchObject([{ callId: "already-done" }]);
    await h.lane.stop();
  });

  it("sets an advertised model and rejects an unknown model before prompting", async () => {
    for (const name of ["test-model", "missing"]) {
      const h = setup();
      h.ctx.config.runtimeConfig = { model: { kind: "named", name } };
      const result = await h.lane.start({ text: "hello" });
      expect(result).toMatchObject(name === "test-model" ? { ok: true } : { ok: false, reason: "incompatible_configuration" });
      expect(h.messages.some((message) => message.method === "session/set_model")).toBe(name === "test-model");
      await h.lane.stop();
    }
  });

  it("stops on malformed protocol and refuses later input", async () => {
    const h = setup();
    await h.lane.start({ text: "first" });
    h.proc.stdout.write("not json\n");
    await vi.waitFor(() => expect(h.proc.kill).toHaveBeenCalled());
    await expect(h.lane.send({ text: "later", mode: "idle" })).resolves.toMatchObject({ ok: false, reason: "closed" });
  });

  it("probes native initialize without creating a session or launching interactive auth", async () => {
    const h = setup();
    const cleanup = vi.fn(async () => { h.proc.kill(); });
    expect(await probeAntigravity("/custom/agy_acp_server.par", { spawn: (() => h.proc) as never, cleanup })).toEqual({ status: "healthy", version: "1.3.0" });
    expect(h.messages.map((message) => message.method)).toEqual(["initialize"]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["silent", "antigravity_acp_timeout"],
    ["invalid", "antigravity_acp_invalid_json"],
    ["oversized", "antigravity_acp_output_limit"],
    ["foreign", "antigravity_acp_incompatible"],
    ["exit", "antigravity_acp_process_exited"],
  ])("bounds and cleans failed %s probes", async (scenario, lastError) => {
    const h = setup();
    h.proc.stdin.removeAllListeners("data");
    h.proc.stdin.on("data", () => {
      if (scenario === "invalid") h.proc.stdout.write("invalid\n");
      if (scenario === "oversized") h.proc.stdout.write("x".repeat(1024 * 1024 + 1));
      if (scenario === "foreign") h.emit({ id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "wrapper" } } });
      if (scenario === "exit") h.proc.emit("exit", 1, null);
    });
    const cleanup = vi.fn(async () => { h.proc.kill(); });
    await expect(probeAntigravity(undefined, { spawn: (() => h.proc) as never, cleanup, timeoutMs: 10 }))
      .resolves.toEqual({ status: "unhealthy", lastError });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports a missing executable and cleanup failures without claiming health", async () => {
    await expect(probeAntigravity(undefined, { spawn: (() => { throw new Error("ENOENT"); }) as never }))
      .resolves.toMatchObject({ status: "unhealthy", lastError: "antigravity_acp_spawn_failed" });
    const h = setup();
    await expect(probeAntigravity(undefined, { spawn: (() => h.proc) as never, cleanup: async () => { throw new Error("cleanup"); } }))
      .resolves.toMatchObject({ status: "unhealthy", lastError: "antigravity_acp_cleanup_failed" });
  });

  it("uses the native server and Linux uid flag, never print mode", () => {
    expect(antigravitySpawnSpec("/custom/native", "linux")).toMatchObject({ command: "/custom/native", args: ["--uid="] });
    expect(antigravitySpawnSpec("/custom/native", "darwin")).toMatchObject({ command: "/custom/native", args: [] });
  });
});
