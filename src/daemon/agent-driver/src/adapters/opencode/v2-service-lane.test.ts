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
  respond?: (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;
  readonly child = Object.assign(new EventEmitter(), {
    pid: 42_199, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
    exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn(() => true),
  });

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const override = await this.respond?.(url, init);
    if (override) return override;
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

  lane(model: string | null = "opencode/space-bunny-free") {
    const lane = new OpenCodeV2ServiceLane(
      { spawnService: async () => ({ process: this.child }) },
      fakeLaunchContext("opencode", process.cwd(), { config: { runtimeConfig: { model: model === null ? { kind: "default" } : { kind: "named", name: model } } } }),
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
  it.each([{ pid: 1 }, { version: "2.0.28", pid: 0 }, { version: "3.0.0", pid: 1 }])("rejects incompatible native health before admitting inputs: %j", async health => {
    const native = new NativeV2(); native.respond = url => url.pathname === "/api/info" ? Response.json(health) : undefined;
    expect(await native.lane().start({ text: "one", terminalOwner: "msg_root" })).toMatchObject({ ok: false, reason: "incompatible_configuration" });
    expect(native.inputs).toHaveLength(0);
  });

  it("keeps default model selection and complete reasoning, compaction and sparse usage semantics", async () => {
    const native = new NativeV2(); const lane = native.lane(null);
    expect(await lane.send({ mode: "idle", text: "early" })).toMatchObject({ ok: false, reason: "closed" });
    await lane.start({ text: "one", terminalOwner: "msg_root" }); expect(native.model).toBeUndefined();
    expect(await lane.send({ mode: "idle", text: "duplicate" })).toMatchObject({ ok: false, reason: "runtime_busy" });
    native.emit("session.compaction.started"); native.emit("session.compaction.failed");
    native.deliver(); native.messages.push({ id: "msg_reason", type: "assistant", time: { completed: 2 }, content: [{ type: "reasoning", text: "settled reasoning" }, { type: "text", text: "" }] }); native.finish();
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    expect(native.events).toEqual(expect.arrayContaining([{ kind: "assistant_reasoning_completed", text: "settled reasoning" }, { kind: "compaction_started" }, { kind: "compaction_finished" }]));
    expect(native.events.some(event => event.kind === "telemetry")).toBe(false);
    expect(await lane.send({ mode: "busy", text: "late" })).toMatchObject({ ok: false, reason: "not_ready" });
  });

  it.each(["http", "receipt"])("rejects a failed %s prompt admission without a terminal receipt", async kind => {
    const native = new NativeV2(); native.respond = url => url.pathname.endsWith("/prompt") ? kind === "http" ? new Response(null, { status: 400 }) : Response.json({ data: {} }) : undefined;
    await expect(native.lane().start({ text: "one", terminalOwner: "msg_root" })).rejects.toThrow(kind === "http" ? "HTTP 400" : "invalid prompt receipt");
    expect(native.ends).toHaveLength(0); expect(native.inputs).toHaveLength(0);
  });

  it.each(["page", "cursor", "http"])("rejects invalid initial native message %s", async kind => {
    const native = new NativeV2(); native.respond = url => url.pathname.endsWith("/message") ? kind === "http" ? new Response(null, { status: 400 }) : Response.json(kind === "page" ? { data: {} } : { data: [], cursor: { next: 42 } }) : undefined;
    await expect(native.lane().start({ text: "one", terminalOwner: "msg_root" })).rejects.toThrow(kind === "http" ? "HTTP 400" : "invalid message");
    expect(native.inputs).toHaveLength(0); expect(native.ends).toHaveLength(0);
  });

  it.each(["boundary", "cursor", "active", "inbox_http", "inbox_shape", "input_http", "input_shape", "idle"])("fails native recovery closed on %s corruption", async kind => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.active = false;
    if (kind === "boundary") native.messages.splice(0);
    if (kind.startsWith("input")) native.inputs.splice(0);
    if (kind === "idle") { native.deliver(); native.finish("msg_invalid_idle", "unknown"); }
    native.respond = url => {
      if (kind === "cursor" && url.pathname.endsWith("/message")) return Response.json({ data: [], cursor: { next: "repeated" } });
      if (kind === "active" && url.pathname === "/api/session/active") return Response.json({ data: null });
      if (kind.startsWith("inbox") && url.pathname.endsWith("/inbox")) return kind === "inbox_http" ? new Response(null, { status: 400 }) : Response.json({ data: null });
      if (kind.startsWith("input") && url.pathname.includes("/message/")) return kind === "input_http" ? new Response(null, { status: 400 }) : Response.json({ data: { id: url.pathname.split("/").at(-1), type: "assistant" } });
    };
    await vi.waitFor(() => expect(native.errors).toHaveLength(1)); expect(native.ends).toHaveLength(0);
  });

  it("closes the lane when native interruption fails instead of settling the root", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" });
    native.respond = url => url.pathname.endsWith("/interrupt") ? new Response(null, { status: 400 }) : undefined;
    await expect(lane.interrupt({ reason: "user_interrupt" })).rejects.toThrow("HTTP 400");
    expect(await lane.send({ mode: "idle", text: "late" })).toMatchObject({ ok: false, reason: "closed" }); expect(native.ends).toHaveLength(0);
  });

  it("fails unexpected stream faults during startup without admitting input", async () => {
    const native = new NativeV2(); const lane = native.lane();
    vi.spyOn(lane as unknown as { runLiveStream: () => Promise<void> }, "runLiveStream").mockRejectedValueOnce(new Error("unexpected native stream fault"));
    await expect(lane.start({ text: "one", terminalOwner: "msg_root" })).rejects.toThrow();
    expect(native.errors).toHaveLength(1); expect(native.inputs).toHaveLength(0); expect(native.ends).toHaveLength(0);
  });

  it("closes admission when physical identity is lost during the baseline snapshot", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" }); native.deliver(); native.finish();
    await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    native.respond = url => { if (url.pathname.endsWith("/message")) native.child.exitCode = 1; };
    expect(await lane.send({ mode: "idle", text: "late", terminalOwner: "msg_next" })).toMatchObject({ ok: false, reason: "closed" });
    expect(native.inputs).toHaveLength(0);
  });

  it("fences both queued and returned admissions after the service exits", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" });
    let release!: () => void; native.delayPrompt = new Promise<void>(resolve => { release = resolve; });
    const first = lane.send({ mode: "busy", text: "first" }); const second = lane.send({ mode: "busy", text: "second" });
    await new Promise(resolve => setTimeout(resolve, 5)); native.child.exitCode = 1; release();
    expect(await first).toMatchObject({ ok: false, reason: "closed" }); expect(await second).toMatchObject({ ok: false, reason: "closed" }); expect(native.ends).toHaveLength(0);
  });

  it.each(["message", "inbox", "input"])("ignores late %s recovery after stop", async phase => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" }); native.active = false;
    if (phase === "input") native.inputs.splice(0);
    native.respond = async url => {
      const target = phase === "message" ? url.pathname.endsWith("/message") : phase === "inbox" ? url.pathname.endsWith("/inbox") : url.pathname.includes("/message/");
      if (!target) return;
      void lane.stop({ reason: "shutdown" });
      if (phase === "message") return Response.json({ data: [], cursor: {} });
      if (phase === "inbox") return Response.json({ data: [] });
      return Response.json({ data: { id: "stale", type: "user" } });
    };
    await vi.waitFor(() => expect(native.events.some(event => event.kind === "runtime_metric" && event.name === "sse_reconnect")).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 20)); expect(native.ends).toHaveLength(0); expect(native.errors).toHaveLength(0);
  });

  it("does not settle stale page results when a new busy input arrives", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" }); native.deliver(); native.finish();
    let admitted: Promise<unknown> | undefined;
    native.respond = async url => {
      if (!url.pathname.endsWith("/message") || admitted) return;
      admitted = lane.send({ mode: "busy", text: "new input" }); await admitted;
    };
    await vi.waitFor(() => expect(admitted).toBeDefined()); expect(native.ends).toHaveLength(0);
    native.deliver(); native.finish("msg_next_idle"); await vi.waitFor(() => expect(native.ends).toHaveLength(1));
  });

  it("does not project recovered tools after a root has stopped", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" }); native.deliver();
    native.messages.push({ id: "msg_tool", type: "assistant", content: [{ type: "tool", id: "call", name: "shell", state: { status: "running", input: {} } }] });
    native.respond = async url => { if (url.pathname.endsWith("/message")) { void lane.stop({ reason: "shutdown" }); return Response.json({ data: [], cursor: {} }); } };
    native.stream?.close(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(native.events.filter(event => event.kind === "tool_call")).toHaveLength(0); expect(native.ends).toHaveLength(0);
  });

  it("starts a fresh native message history and ignores child, orphan and post-root live signals", async () => {
    const native = new NativeV2(); native.messages.splice(0); const lane = native.lane();
    const admitted = await lane.start({ text: "one", terminalOwner: "host-owner" }); expect(admitted).toMatchObject({ ok: true, receipt: expect.stringMatching(/^msg_/) });
    native.emit("session.step.started"); native.emit("session.step.started", { sessionID: "ses_child" });
    native.emit("session.tool.success", { assistantMessageID: "msg_unseen", id: "orphan" });
    await vi.waitFor(() => expect(native.events.filter(event => event.kind === "internal_progress")).toHaveLength(1));
    native.deliver(); native.finish(); await vi.waitFor(() => expect(native.ends).toHaveLength(1));
    native.emit("session.step.started"); await new Promise(resolve => setTimeout(resolve, 10));
    expect(native.events.filter(event => event.kind === "internal_progress")).toHaveLength(1);
    expect(native.events.filter(event => event.kind === "tool_output")).toHaveLength(0);
  });

  it("discards inactive results after physical service identity is lost", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" });
    let observed = false; native.respond = url => { if (url.pathname === "/api/session/active") { observed = true; native.child.exitCode = 1; return Response.json({ data: {} }); } };
    await vi.waitFor(() => expect(observed).toBe(true)); expect(native.ends).toHaveLength(0); expect(native.errors).toHaveLength(0);
  });

  it("ignores a malformed late recovery response after shutdown", async () => {
    const native = new NativeV2(); const lane = native.lane(); await lane.start({ text: "one", terminalOwner: "msg_root" }); native.active = false;
    let observed = false; native.respond = url => { if (url.pathname.endsWith("/message")) { observed = true; void lane.stop({ reason: "shutdown" }); return Response.json({ data: null }); } };
    await vi.waitFor(() => expect(observed).toBe(true)); await new Promise(resolve => setTimeout(resolve, 10));
    expect(native.ends).toHaveLength(0); expect(native.errors).toHaveLength(0);
  });

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
    await vi.waitFor(() => expect(native.ends).toEqual([{ kind: "turn_end", sessionId: native.id, turnOwner: "msg_root", outcome: "interrupted" }]));
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
