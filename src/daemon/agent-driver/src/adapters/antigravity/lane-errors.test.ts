import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AdapterEvent, SpawnedProcessHandle } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { AntigravityAcpLane } from "./acp-lane.js";

type Rpc = Record<string, unknown>;
function harness(handler?: (request: Rpc, send: (value: Rpc) => void) => boolean) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => { proc.signalCode = "SIGTERM"; proc.emit("exit", null, "SIGTERM"); return true; }),
  });
  const requests: Rpc[] = [];
  const send = (value: Rpc) => { proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`); };
  proc.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line) as Rpc;
      requests.push(request);
      if (handler?.(request, send)) continue;
      if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, agentInfo: { name: "antigravity-acp" }, agentCapabilities: { loadSession: true } } });
      if (request.method === "session/new" || request.method === "session/load") send({ id: request.id, result: { sessionId: "native" } });
    }
  });
  const ctx = fakeLaunchContext("antigravity", "/tmp", { config: { runtimeConfig: { model: { kind: "default" } } } });
  const factory = { spawn: vi.fn(async () => ({ process: proc as SpawnedProcessHandle })) };
  const lane = new AntigravityAcpLane(factory, ctx, { handshakeTimeoutMs: 15, onRawStdoutLine: () => { throw new Error("observer"); } });
  const events: AdapterEvent[] = [];
  lane.on("runtime_event", (event) => events.push(event));
  lane.on("error", () => {});
  const update = (value: Rpc) => send({ method: "session/update", params: { sessionId: "native", update: value } });
  const prompt = () => requests.filter((request) => request.method === "session/prompt").at(-1)!;
  return { proc, requests, send, ctx, factory, lane, events, update, prompt };
}

describe("Antigravity transport and lifecycle faults", () => {
  it.each([null, {}, { sessionId: "" }, { sessionId: 5 }])("rejects invalid session response %j", async (result) => {
    const h = harness((r, send) => { if (r.method !== "session/new") return false; send({ id: r.id, result }); return true; });
    await expect(h.lane.start({ text: "first" })).rejects.toThrow();
    expect(h.proc.kill).toHaveBeenCalledTimes(1);
  });

  it.each([{ protocolVersion: 2 }, { protocolVersion: 1, agentInfo: { name: "foreign" } }])("rejects incompatible handshake %j", async (result) => {
    const h = harness((r, send) => { if (r.method !== "initialize") return false; send({ id: r.id, result }); return true; });
    expect(await h.lane.start({ text: "first" })).toMatchObject({ ok: false, reason: "incompatible_configuration" });
  });

  it.each(["timeout", "missing-result", "rpc-error", "write-error", "closed-stdin"])("releases failed %s startup", async (fault) => {
    const h = harness((r, send) => {
      if (r.method !== "initialize") return false;
      if (fault === "timeout") return true;
      if (fault === "missing-result") { send({ id: r.id }); return true; }
      if (fault === "rpc-error") { send({ id: r.id, error: { data: { message: "detail" } } }); return true; }
      return false;
    });
    if (fault === "write-error") vi.spyOn(h.proc.stdin, "write").mockImplementation(() => { throw new Error("write"); });
    if (fault === "closed-stdin") h.proc.stdin.destroy();
    await expect(h.lane.start({ text: "first" })).rejects.toThrow();
    expect(h.proc.kill).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "error", "exit"])("fences %s racing the final handshake", async (fault) => {
    const h = harness((r, send) => {
      if (r.method !== "session/new") return false;
      send({ id: r.id, result: { sessionId: "native" } });
      if (fault === "stop") void h.lane.stop();
      if (fault === "error") h.proc.emit("error", new Error("startup"));
      if (fault === "exit") { h.proc.exitCode = 1; h.proc.emit("exit", 1, null); }
      return true;
    });
    await expect(h.lane.start({ text: "first" })).rejects.toThrow();
    expect(h.requests.some((r) => r.method === "session/prompt")).toBe(false);
  });

  it("preserves a stop issued before spawn resolves", async () => {
    const h = harness();
    let release!: () => void;
    h.factory.spawn.mockImplementation(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { process: h.proc as SpawnedProcessHandle }; });
    const start = h.lane.start({ text: "first" });
    const stopped = h.lane.stop();
    release();
    await expect(start).rejects.toThrow("cancelled");
    await stopped;
    expect(h.requests).toHaveLength(0);
    expect(h.proc.kill).toHaveBeenCalledTimes(1);
  });

  it("preserves resume identity without an echoed id and rejects unrelated load failures", async () => {
    for (const failure of [false, true]) {
      const h = harness((r, send) => { if (r.method !== "session/load") return false; send(failure ? { id: r.id, error: { code: -32603, message: "network" } } : { id: r.id, result: {} }); return true; });
      if (failure) await expect(h.lane.start({ text: "resume", sessionId: "saved" })).rejects.toThrow("network");
      else { expect(await h.lane.start({ text: "resume", sessionId: "saved" })).toMatchObject({ ok: true }); expect(h.lane.currentSessionId).toBe("saved"); }
      await h.lane.stop();
    }
  });

  it("rolls back failed prompt/cancel writes and still admits the next valid turn", async () => {
    const h = harness();
    expect(await h.lane.interrupt({})).toBe(false);
    expect(await h.lane.send({ text: "early", mode: "idle" })).toMatchObject({ ok: false });
    expect(await h.lane.updateSettings({ reasoningEffort: "high" })).toMatchObject({ status: "failed" });
    await h.lane.start({ text: "first" });
    expect(await h.lane.start({ text: "duplicate" })).toMatchObject({ ok: false });
    const write = vi.spyOn(h.proc.stdin, "write").mockImplementationOnce(() => { throw new Error("cancel write"); });
    await expect(h.lane.interrupt({})).rejects.toThrow("cancel write");
    write.mockRestore();
    h.send({ id: h.prompt().id, result: { stopReason: "end_turn" } });
    const broken = vi.spyOn(h.proc.stdin, "write").mockImplementationOnce(() => { throw new Error("prompt write"); });
    await expect(h.lane.send({ text: "second", mode: "idle" })).rejects.toThrow("prompt write");
    broken.mockRestore();
    expect(await h.lane.send({ text: "retry", mode: "idle" })).toMatchObject({ ok: true });
    await h.lane.stop();
  });

  it.each(["oversized", "wrong-version", "no-method", "unwritable-reply"])("closes malformed %s transport", async (fault) => {
    const h = harness();
    await h.lane.start({ text: "first" });
    if (fault === "oversized") h.proc.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
    if (fault === "wrong-version") h.send({ jsonrpc: "1.0" });
    if (fault === "no-method") h.send({});
    if (fault === "unwritable-reply") { h.proc.stdin.destroy(); h.send({ id: 91, method: "unsupported" }); }
    await vi.waitFor(() => expect(h.proc.kill).toHaveBeenCalled());
  });

  it("reports one crash exit and fences later duplicate error/exit", async () => {
    const h = harness();
    const exits = vi.fn();
    const stderr = vi.fn();
    h.lane.on("exit", exits); h.lane.on("stderr", stderr);
    await h.lane.start({ text: "first" });
    h.proc.stderr.write("diagnostic\n");
    h.proc.emit("error", "broken");
    h.proc.emit("error", new Error("duplicate"));
    h.proc.emit("exit", 1, null);
    expect(exits).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith("diagnostic");
    await h.lane.stop();
  });

  it("keeps control messages and terminal tools separate from root completion", async () => {
    const h = harness();
    await h.lane.start({ text: "first" });
    h.proc.stdout.write("\n");
    h.send({ id: "unknown", result: {} });
    h.send({ id: 91, method: "unsupported" });
    expect(h.requests.at(-1)).toMatchObject({ id: 91, error: { code: -32601 } });
    h.send({ method: "vendor/unknown" });
    h.update({ sessionUpdate: "unknown" });
    h.update({ sessionUpdate: "tool_call" });
    h.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "shell" });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" });
    h.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } });
    h.update({ sessionUpdate: "user_message_chunk" });
    h.update({ sessionUpdate: "usage_update", used: 400, size: 1000 });
    h.update({ sessionUpdate: "plan" });
    h.update({ sessionUpdate: "config_option_update", configOptions: [] });
    expect(h.events.filter((e) => e.kind === "telemetry")).toEqual([]);
    h.send({ id: h.prompt().id });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
    expect(h.events.filter((e) => e.kind === "turn_end")).toHaveLength(1);
    expect(h.events.some((e) => e.kind === "assistant_message_delta")).toBe(false);
    await h.lane.stop();
  });
});

it("rejects an in-flight handshake when the owned process fails", async () => {
  const h = harness((request) => { if (request.method === "initialize") { queueMicrotask(() => h.proc.emit("error", new Error("handshake process failure"))); return true; } return false; });
  await expect(h.lane.start({ text: "first" })).rejects.toThrow("handshake process failure");
  expect(h.proc.kill).toHaveBeenCalledTimes(1);
});
