import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEvent } from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { OpenCodeV2ServiceLane } from "./v2-service-lane.js";

vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  killProcessTree: vi.fn(async () => {}),
}));

type Row = Record<string, unknown>;
const paths = [
  "/api/session", "/api/session/active", "/api/session/{sessionID}",
  "/api/session/{sessionID}/prompt", "/api/session/{sessionID}/inbox", "/api/session/{sessionID}/message",
  "/api/session/{sessionID}/message/{messageID}",
  "/api/session/{sessionID}/interrupt", "/api/session/{sessionID}/model", "/api/session/{sessionID}/permission",
  "/api/session/{sessionID}/permission/{requestID}/reply", "/api/event",
];
const lanes: OpenCodeV2ServiceLane[] = [];
afterEach(async () => { for (const lane of lanes.splice(0)) await lane.stop({ reason: "test_cleanup" }); vi.restoreAllMocks(); });

class NativeV2 {
  readonly id = "ses_test";
  readonly inputs: Row[] = [];
  readonly messages: Row[] = [{ id: "msg_old_idle", type: "idle", outcome: "succeeded" }];
  readonly events: AdapterEvent[] = [];
  readonly errors: unknown[] = [];
  active = true;
  model: unknown;
  connections = 0;
  activeFailures = 0;
  interruptQuery?: string;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  permissionBody?: unknown;
  delayPrompt?: Promise<void>;
  beforeInbox?: () => void;
  readonly child = Object.assign(new EventEmitter(), {
    pid: 42_199, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
    exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn(() => true),
  });

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (value: unknown) => Response.json(value);
    if (url.pathname === "/api/info") return json({ version: "2.0.28", pid: this.child.pid });
    if (url.pathname === "/openapi.json") return json({ paths: Object.fromEntries(paths.map((path) => [path, {}])) });
    if (url.pathname === "/api/session" && init?.method === "POST") {
      this.model = JSON.parse(String(init.body)).model;
      return json({ data: { id: this.id, model: this.model } });
    }
    if (url.pathname === "/api/session/active" && this.activeFailures-- > 0) return new Response(null, { status: 503 });
    if (url.pathname === "/api/session/active") return json({ data: this.active ? { [this.id]: { type: "running" }, ses_child: { type: "running" } } : { ses_child: { type: "running" } } });
    if (url.pathname === "/api/event") {
      this.connections += 1;
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.stream = controller;
          init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/permission")) return json({ data: [] });
    if (url.pathname.endsWith("/permission/per_test/reply")) { this.permissionBody = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/message")) {
      const data = [...this.messages].reverse();
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("cursor")?.slice(7) ?? 0);
      return json({ data: data.slice(offset, offset + limit), cursor: { previous: null, next: offset + limit < data.length ? `cursor_${offset + limit}` : null } });
    }
    if (url.pathname.endsWith("/inbox")) { this.beforeInbox?.(); return json({ data: this.inputs }); }
    if (url.pathname.includes("/message/")) {
      const message = this.messages.find((item) => item.id === url.pathname.split("/").at(-1));
      return message ? json({ data: message }) : new Response(null, { status: 404 });
    }
    if (url.pathname.endsWith("/prompt")) {
      const body = JSON.parse(String(init?.body));
      if (typeof body.text !== "string" || body.prompt !== undefined) return new Response(null, { status: 400 });
      if (this.delayPrompt) await this.delayPrompt;
      const item = { ...body, type: "user", sessionID: this.id };
      this.inputs.push(item);
      return json({ data: item });
    }
    if (url.pathname.endsWith("/interrupt")) { this.interruptQuery = url.search; return json({ interrupted: true }); }
    throw new Error(`Unexpected v2 route ${url.pathname}`);
  };

  lane(model = "opencode/space-bunny-free") {
    const lane = new OpenCodeV2ServiceLane(
      { spawnService: async () => ({ process: this.child }) },
      fakeLaunchContext("opencode", process.cwd(), { config: { runtimeConfig: { model: { kind: "named", name: model } } } }),
      { fetch: this.fetch, allocatePort: async () => 43_123, activePollMs: 2, reconnectDelayMs: 2 },
    );
    lane.on("runtime_event", (event) => this.events.push(event));
    lane.on("error", (error) => this.errors.push(error));
    lanes.push(lane);
    return lane;
  }

  deliver() {
    for (const input of this.inputs.splice(0)) this.messages.push({ ...input, type: "user" });
  }

  finish(id = "msg_new_idle", outcome = "succeeded") {
    this.messages.push({ id, type: "idle", outcome });
    this.active = false;
  }

  emit(type: string, data: Row = {}) {
    this.stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data: { sessionID: this.id, ...data } })}\n\n`));
  }

  get ends() { return this.events.filter((event) => event.kind === "turn_end"); }
}

describe("OpenCode CLI v2 persisted message authority", () => {
  it("uses the exact selected model and ignores old idle, child activity and streamed-only output", async () => {
    const native = new NativeV2();
    const lane = native.lane("opencode/space-bunny-free#high");
    expect(await lane.start({ text: "one", terminalOwner: "msg_root" })).toMatchObject({ ok: true, receipt: "msg_root" });
    expect(native.model).toEqual({ providerID: "opencode", id: "space-bunny-free", variant: "high" });
    native.active = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.ends).toHaveLength(0);
    native.deliver();
    native.messages.push({ id: "msg_assistant", type: "assistant", time: { streamed: 12 }, content: [{ type: "text", text: "incomplete" }] });
    native.emit("session.step.ended", { finish: "stop" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.ends).toHaveLength(0);
    native.finish();
    await vi.waitFor(() => expect(native.ends).toEqual([{ kind: "turn_end", sessionId: native.id, turnOwner: "msg_root" }]));
    expect(native.errors).toHaveLength(0);
  });

  it("projects actual v2 tool IDs and restores missed running/completed tools after reconnect", async () => {
    const native = new NativeV2(); const lane = native.lane();
    await lane.start({ text: "tools", terminalOwner: "msg_root" }); native.deliver();
    native.emit("session.tool.input.started", { assistantMessageID: "msg_a", id: "call_one", name: "bash" });
    native.emit("session.tool.called", { assistantMessageID: "msg_a", id: "call_one", input: { command: "true" }, executed: true });
    await vi.waitFor(() => expect(native.events.filter(event => event.kind === "tool_call")).toHaveLength(1));
    native.stream?.close();
    native.messages.push({ id: "msg_a", type: "assistant", content: [
      { type: "tool", id: "call_one", name: "bash", state: { status: "completed", input: { command: "true" } } },
      { type: "tool", id: "call_two", name: "bash", state: { status: "running", input: { command: "sleep 1" } } },
    ] });
    await vi.waitFor(() => expect(native.events.filter(event => event.kind === "tool_call")).toHaveLength(2));
    expect(native.events.filter(event => event.kind === "tool_output")).toEqual([{ kind: "tool_output", callId: "msg_a:call_one", name: "bash" }]);
    native.emit("session.tool.success", { assistantMessageID: "msg_a", id: "call_two", executed: true });
    await vi.waitFor(() => expect(native.events.filter(event => event.kind === "tool_output")).toHaveLength(2));
    native.finish(); await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    expect(native.events.filter(event => event.kind === "tool_call")).toHaveLength(2);
    expect(native.errors).toHaveLength(0);
  });

  it("retains busy admission until every input is delivered and followed by a new idle", async () => {
    const native = new NativeV2();
    const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.deliver();
    let release!: () => void;
    native.delayPrompt = new Promise<void>((resolve) => { release = resolve; });
    const sending = lane.send({ mode: "busy", text: "two" });
    native.finish("msg_first_idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.ends).toHaveLength(0);
    release();
    expect(await sending).toMatchObject({ ok: true, acceptedAs: "steer" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.ends).toHaveLength(0);
    native.deliver();
    native.finish("msg_second_idle");
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    expect(native.errors).toHaveLength(0);
  });

  it("recovers a disconnected live stream from persisted messages and reuses the same session", async () => {
    const native = new NativeV2();
    const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.stream!.close();
    await vi.waitFor(() => expect(native.connections).toBeGreaterThan(1));
    native.deliver();
    for (let n = 0; n < 110; n++) native.messages.push({ id: `msg_note_${n}`, type: "system" });
    native.messages.push({ id: "msg_answer", type: "assistant", time: { completed: 20 }, content: [{ type: "text", text: "done" }], tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 0 } } });
    native.finish();
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    expect(native.events.filter((event) => event.kind === "assistant_message_completed")).toEqual([{ kind: "assistant_message_completed", text: "done" }]);
    expect(native.events.filter((event) => event.kind === "telemetry")).toHaveLength(1);
    native.active = true;
    expect(await lane.send({ mode: "idle", text: "second", terminalOwner: "msg_second" })).toMatchObject({ ok: true });
    native.deliver();
    native.finish("msg_second_idle");
    await vi.waitFor(() => expect(native.ends).toHaveLength(2));
    expect(lane.currentSessionId).toBe(native.id);
    expect(native.events.filter((event) => event.kind === "session_init")).toHaveLength(1);
    expect(native.errors).toHaveLength(0);
  });

  it("uses the v2 permission decision and fences callbacks after shutdown", async () => {
    const native = new NativeV2();
    const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.emit("permission.asked", { id: "per_test" });
    await vi.waitFor(() => expect(native.permissionBody).toEqual({ decision: "once" }));
    await lane.stop({ reason: "shutdown" });
    native.deliver();
    native.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.ends).toHaveLength(0);
  });

  it("waits for native interrupted idle instead of treating an interrupt receipt as completion", async () => {
    const native = new NativeV2(); const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" });
    expect(await lane.interrupt({ reason: "user_interrupt" })).toBe(true);
    expect(native.interruptQuery).toBe("?resume=false");
    expect(native.ends).toHaveLength(0);
    native.deliver(); native.finish("msg_interrupted", "interrupted");
    await vi.waitFor(() => expect(native.ends).toEqual([{ kind: "turn_end", sessionId: native.id, turnOwner: "msg_root" }]));
    expect(await lane.interrupt({ reason: "user_interrupt" })).toBe(false);
    expect(native.errors).toHaveLength(0);
  });

  it("reports a failed native idle for its root and keeps the persistent lane reusable", async () => {
    const native = new NativeV2(); const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" }); native.deliver();
    native.finish("msg_failure", "failed"); native.messages.at(-1)!.error = { message: "provider unavailable" };
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    expect(native.events.filter(event => event.kind === "error")).toEqual([{ kind: "error", code: "opencode.turn_failed", message: "provider unavailable" }]);
    expect(native.errors).toHaveLength(0);
    expect(await lane.send({ mode: "idle", text: "retry", terminalOwner: "msg_retry" })).toMatchObject({ ok: true });
    native.deliver(); native.finish("msg_retry_idle");
    await vi.waitFor(() => expect(native.ends).toHaveLength(2));
    expect(native.ends[1]).toMatchObject({ turnOwner: "msg_retry" });
  });

  it("keeps accepted inputs owned through a temporary native recovery outage", async () => {
    const native = new NativeV2(); const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" }); native.activeFailures = 1;
    await vi.waitFor(() => expect(native.events.some(event => event.kind === "runtime_diagnostic" && event.message.includes("temporarily unavailable"))).toBe(true));
    expect(native.ends).toHaveLength(0); expect(native.errors).toHaveLength(0);
    native.deliver(); native.finish();
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
  });

  it("fails explicitly if accepted input is absent from both inbox and persisted messages", async () => {
    const native = new NativeV2();
    const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.inputs.splice(0);
    native.finish();
    await vi.waitFor(() => expect(native.errors).toHaveLength(1));
    expect(native.ends).toHaveLength(0);
  });

  it("rechecks a persisted input that moved out of inbox after the messages snapshot", async () => {
    const native = new NativeV2();
    const lane = native.lane();
    await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.active = false;
    native.beforeInbox = () => {
      native.beforeInbox = undefined;
      native.deliver();
      native.finish();
    };
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    expect(native.errors).toHaveLength(0);
  });
});
