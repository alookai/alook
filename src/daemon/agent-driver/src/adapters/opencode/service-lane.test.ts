import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterEvent,
  RuntimeLaneEventMap,
  SpawnedProcessHandle,
} from "../../internal/adapter.js";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import {
  OpenCodeServiceLane,
  type OpenCodeServiceProcessFactory,
} from "./service-lane.js";

const killProcessTree = vi.hoisted(() => vi.fn());
vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  killProcessTree,
}));

type MutableProcess = SpawnedProcessHandle & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  emit(event: string, ...args: unknown[]): boolean;
};

interface PendingResponse {
  readonly respond: () => void;
}

const REQUIRED_PATHS = [
  "/api/session",
  "/api/session/active",
  "/api/session/{sessionID}/prompt",
  "/api/session/{sessionID}/event",
  "/api/session/{sessionID}/history",
  "/api/session/{sessionID}/interrupt",
  "/api/session/{sessionID}/model",
  "/api/session/{sessionID}/permission",
  "/api/session/{sessionID}/permission/{requestID}/reply",
  "/api/event",
];

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

class FakeOpenCodeService {
  sessionId = "ses_fake";
  readonly prompts: Record<string, unknown>[] = [];
  readonly permissionReplies: Record<string, unknown>[] = [];
  readonly authHeaders: string[] = [];
  readonly durableEvents: Record<string, unknown>[] = [];
  readonly pendingPromptResponses: PendingResponse[] = [];
  readonly pendingActiveResponses: PendingResponse[] = [];
  readonly pendingHistoryResponses: PendingResponse[] = [];
  readonly durableClients = new Set<ServerResponse>();
  readonly liveClients = new Set<ServerResponse>();
  readonly heldDurableClients: ServerResponse[] = [];
  readonly stalledJsonResponses = new Set<ServerResponse>();
  readonly stallJsonBodies = new Set<"health" | "history" | "prompt" | "active">();
  readonly pendingPermissions: Record<string, unknown>[] = [];
  readonly existingSessions = new Set<string>();
  active = false;
  holdPromptResponses = false;
  holdActiveResponses = false;
  holdHistoryResponses = false;
  holdDurableConnections = false;
  malformedPromptReceipt = false;
  malformedActiveResponse = false;
  createCount = 0;
  interruptCount = 0;
  activeCount = 0;
  private seq = 0;
  private eventId = 0;
  private server: Server;

  constructor(
    readonly port: number,
    readonly password: string,
    readonly process: MutableProcess,
    readonly healthVersion = "1.17.20",
    readonly healthStatus = 200,
  ) {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
  }

  close(signal = "SIGTERM"): void {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    for (const response of [
      ...this.durableClients,
      ...this.liveClients,
      ...this.heldDurableClients,
      ...this.stalledJsonResponses,
    ]) response.destroy();
    this.server.close();
    this.process.signalCode = signal;
    this.process.emit("exit", null, signal);
  }

  releasePrompt(): void {
    this.pendingPromptResponses.shift()?.respond();
  }

  releaseActive(): void {
    this.pendingActiveResponses.shift()?.respond();
  }

  releaseHistory(): void {
    this.pendingHistoryResponses.shift()?.respond();
  }

  releaseDurableConnections(): void {
    this.holdDurableConnections = false;
    for (const response of this.heldDurableClients.splice(0)) this.openSse(response, this.durableClients);
  }

  disconnectDurable(): void {
    for (const response of [...this.durableClients]) response.end();
    this.durableClients.clear();
  }

  disconnectLive(): void {
    for (const response of [...this.liveClients]) response.end();
    this.liveClients.clear();
  }

  publish(type: string, data: Record<string, unknown>): number {
    const event = this.appendHistoryOnly(type, data);
    this.broadcast(this.durableClients, event);
    return (event.durable as { seq: number }).seq;
  }

  appendHistoryOnly(type: string, data: Record<string, unknown>): Record<string, unknown> {
    const seq = ++this.seq;
    const event = {
      id: `evt_${++this.eventId}`,
      type,
      durable: { aggregateID: this.sessionId, seq, version: 1 },
      data: { sessionID: this.sessionId, ...data },
    };
    this.durableEvents.push(event);
    return event;
  }

  replayDurable(event: Record<string, unknown>): void {
    this.broadcast(this.durableClients, event);
  }

  finishSuccess(text = "done"): void {
    this.publish("session.next.text.ended", {
      assistantMessageID: `msg_assistant_${this.seq}`,
      textID: `text_${this.seq}`,
      text,
    });
    this.publish("session.next.step.ended", {
      assistantMessageID: `msg_assistant_${this.seq}`,
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    this.active = false;
  }

  askPermission(id = "per_test"): void {
    const permission = { id, sessionID: this.sessionId, action: "read", resources: ["file"] };
    this.pendingPermissions.push(permission);
    this.broadcast(this.liveClients, { id: `evt_live_${id}`, type: "permission.v2.asked", data: permission });
  }

  emitGlobalIdle(): void {
    this.broadcast(this.liveClients, { id: "evt_idle", type: "session.idle", data: { sessionID: this.sessionId } });
  }

  private openSse(response: ServerResponse, collection: Set<ServerResponse>): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();
    collection.add(response);
    response.on("close", () => collection.delete(response));
  }

  private broadcast(clients: Set<ServerResponse>, event: unknown): void {
    for (const response of clients) response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private stallJson(key: "health" | "history" | "prompt" | "active", response: ServerResponse): boolean {
    if (!this.stallJsonBodies.has(key)) return false;
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    this.stalledJsonResponses.add(response);
    response.on("close", () => this.stalledJsonResponses.delete(response));
    return true;
  }

  private authorized(request: IncomingMessage, response: ServerResponse): boolean {
    const header = String(request.headers.authorization ?? "");
    this.authHeaders.push(header);
    const expected = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    if (header === expected) return true;
    json(response, 401, { error: "unauthorized" });
    return false;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.authorized(request, response)) return;
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    if (request.method === "GET" && path === "/global/health") {
      if (this.stallJson("health", response)) return;
      json(response, this.healthStatus, { healthy: this.healthStatus === 200, version: this.healthVersion });
      return;
    }
    if (request.method === "GET" && path === "/doc") {
      json(response, 200, { paths: Object.fromEntries(REQUIRED_PATHS.map((item) => [item, { get: {} }])) });
      return;
    }
    if (request.method === "POST" && path === "/api/session") {
      this.createCount += 1;
      this.existingSessions.add(this.sessionId);
      json(response, 200, { data: { id: this.sessionId } });
      return;
    }
    if (request.method === "GET" && path !== "/api/session/active" && /^\/api\/session\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice("/api/session/".length));
      if (!this.existingSessions.has(id)) json(response, 404, { error: "missing" });
      else {
        this.sessionId = id;
        json(response, 200, { data: { id } });
      }
      return;
    }
    if (request.method === "POST" && /\/model$/.test(path)) {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && path === `/api/session/${this.sessionId}/event`) {
      if (this.holdDurableConnections) this.heldDurableClients.push(response);
      else this.openSse(response, this.durableClients);
      return;
    }
    if (request.method === "GET" && path === "/api/event") {
      this.openSse(response, this.liveClients);
      return;
    }
    if (request.method === "GET" && path === `/api/session/${this.sessionId}/history`) {
      if (this.stallJson("history", response)) return;
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const respond = () => {
        const events = this.durableEvents.filter((event) => {
          const durable = event.durable as { seq: number };
          return durable.seq > after;
        });
        json(response, 200, { data: events.slice(0, limit), hasMore: events.length > limit });
      };
      if (this.holdHistoryResponses) this.pendingHistoryResponses.push({ respond });
      else respond();
      return;
    }
    if (request.method === "POST" && path === `/api/session/${this.sessionId}/prompt`) {
      const body = await requestBody(request);
      this.prompts.push(body);
      const messageId = String(body.id);
      const delivery = String(body.delivery);
      const admittedSeq = this.publish("session.next.prompt.admitted", { messageID: messageId, delivery, prompt: body.prompt });
      this.active = true;
      const respond = () => {
        if (this.stallJson("prompt", response)) return;
        json(response, 200, {
          data: {
            admittedSeq,
            id: this.malformedPromptReceipt ? "msg_wrong" : messageId,
            sessionID: this.sessionId,
            prompt: body.prompt,
            delivery,
            timeCreated: Date.now(),
          },
        });
      };
      if (this.holdPromptResponses) this.pendingPromptResponses.push({ respond });
      else respond();
      return;
    }
    if (request.method === "GET" && path === "/api/session/active") {
      this.activeCount += 1;
      const snapshot = this.active ? { [this.sessionId]: { type: "running" } } : {};
      const respond = () => {
        if (this.stallJson("active", response)) return;
        json(response, 200, this.malformedActiveResponse ? { data: null } : { data: snapshot });
      };
      if (this.holdActiveResponses) this.pendingActiveResponses.push({ respond });
      else respond();
      return;
    }
    if (request.method === "POST" && path === `/api/session/${this.sessionId}/interrupt`) {
      this.interruptCount += 1;
      this.active = false;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && path === `/api/session/${this.sessionId}/permission`) {
      json(response, 200, { data: this.pendingPermissions });
      return;
    }
    const permission = path.match(/^\/api\/session\/[^/]+\/permission\/([^/]+)\/reply$/);
    if (request.method === "POST" && permission) {
      const body = await requestBody(request);
      this.permissionReplies.push({ id: permission[1], ...body });
      const index = this.pendingPermissions.findIndex((item) => item.id === permission[1]);
      if (index >= 0) this.pendingPermissions.splice(index, 1);
      response.writeHead(204).end();
      return;
    }
    json(response, 404, { error: "unknown route" });
  }
}

class FakeOpenCodeFactory implements OpenCodeServiceProcessFactory {
  spawnCount = 0;
  failPortAttempts = 0;
  healthVersion = "1.17.20";
  healthStatus = 200;
  holdSpawn = false;
  readonly stallJsonBodies = new Set<"health" | "history" | "prompt" | "active">();
  readonly existingSessions = new Set<string>();
  service: FakeOpenCodeService | undefined;
  private nextPid = 41000;
  private releaseSpawnGate?: () => void;

  releaseSpawn(): void {
    this.releaseSpawnGate?.();
  }

  async spawnService(_ctx: Parameters<OpenCodeServiceProcessFactory["spawnService"]>[0], port: number, password: string) {
    this.spawnCount += 1;
    if (this.holdSpawn) {
      await new Promise<void>((resolve) => { this.releaseSpawnGate = resolve; });
    }
    if (this.failPortAttempts > 0) {
      this.failPortAttempts -= 1;
      throw new Error("listen EADDRINUSE: address already in use");
    }
    const emitter = new EventEmitter();
    const process = Object.assign(emitter, {
      pid: ++this.nextPid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn((signal = "SIGTERM") => {
        this.service?.close(signal);
        return true;
      }),
    }) as MutableProcess;
    this.service = new FakeOpenCodeService(port, password, process, this.healthVersion, this.healthStatus);
    for (const key of this.stallJsonBodies) this.service.stallJsonBodies.add(key);
    for (const id of this.existingSessions) this.service.existingSessions.add(id);
    await this.service.listen();
    killers.set(process.pid, () => this.service?.close());
    return { process };
  }
}

const factories: FakeOpenCodeFactory[] = [];
const killers = new Map<number, () => void>();

function makeLane(
  factory = new FakeOpenCodeFactory(),
  startTimeoutMs = 1_000,
  requestTimeoutMs = 1_000,
): OpenCodeServiceLane {
  factories.push(factory);
  const lane = new OpenCodeServiceLane(
    factory,
    fakeLaunchContext("opencode", process.cwd(), {
      config: { runtimeConfig: { model: { kind: "default" } } },
    }),
    {
      password: "test-password",
      activePollMs: 5,
      reconnectDelayMs: 5,
      startTimeoutMs,
      requestTimeoutMs,
    },
  );
  return lane;
}

function collectEvents(lane: OpenCodeServiceLane): {
  runtime: AdapterEvent[];
  exits: RuntimeLaneEventMap["exit"][];
  errors: Error[];
} {
  const runtime: AdapterEvent[] = [];
  const exits: RuntimeLaneEventMap["exit"][] = [];
  const errors: Error[] = [];
  lane.on("runtime_event", (event) => runtime.push(event));
  lane.on("exit", (event) => exits.push(event));
  lane.on("error", (error) => errors.push(error instanceof Error ? error : new Error(String(error))));
  return { runtime, exits, errors };
}

async function waitForTurn(events: AdapterEvent[], count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(events.filter((event) => event.kind === "turn_end")).toHaveLength(count);
  });
}

beforeEach(() => {
  killProcessTree.mockReset();
  killProcessTree.mockImplementation(async (pid: number) => killers.get(pid)?.());
});

afterEach(() => {
  for (const factory of factories.splice(0)) factory.service?.close();
  killers.clear();
});

describe("OpenCodeServiceLane authenticated persistent protocol", () => {
  it("keeps pre-spawn stop pending until the eventual child is killed exactly once", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.holdSpawn = true;
    const lane = makeLane(factory);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });
    await vi.waitFor(() => expect(factory.spawnCount).toBe(1));

    let stopSettled = false;
    const stopping = lane.stop({ reason: "pre_spawn_stop", forceAfterMs: 0 })
      .then(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopSettled).toBe(false);

    factory.releaseSpawn();
    await stopping;
    await expect(starting).rejects.toThrow("stopped during startup");
    expect(killProcessTree).toHaveBeenCalledTimes(1);
  });

  it("bounds JSON response bodies for health, history, prompt admission, and active barriers", async () => {
    const healthFactory = new FakeOpenCodeFactory();
    healthFactory.stallJsonBodies.add("health");
    const healthLane = makeLane(healthFactory, 60, 20);
    await expect(healthLane.start({ text: "root", terminalOwner: "msg_health" }))
      .rejects.toThrow("OpenCode service readiness timed out");

    const historyFactory = new FakeOpenCodeFactory();
    historyFactory.stallJsonBodies.add("history");
    const historyLane = makeLane(historyFactory, 1_000, 20);
    await expect(historyLane.start({ text: "root", terminalOwner: "msg_history" }))
      .rejects.toThrow("OpenCode session history response timed out");

    const promptLane = makeLane(new FakeOpenCodeFactory(), 1_000, 20);
    const promptEvents = collectEvents(promptLane);
    await promptLane.start({ text: "root", terminalOwner: "msg_prompt" });
    const promptService = factories.at(-1)!.service!;
    promptService.stallJsonBodies.add("prompt");
    await expect(promptLane.send({ text: "steer", mode: "busy" }))
      .rejects.toThrow("OpenCode prompt admission response timed out");
    expect(promptEvents.errors).toContainEqual(
      new Error("OpenCode prompt admission did not produce a valid durable receipt"),
    );

    const activeLane = makeLane(new FakeOpenCodeFactory(), 1_000, 20);
    const activeEvents = collectEvents(activeLane);
    await activeLane.start({ text: "root", terminalOwner: "msg_active" });
    const activeService = factories.at(-1)!.service!;
    activeService.stallJsonBodies.add("active");
    activeService.finishSuccess();
    await vi.waitFor(() => expect(activeService.activeCount).toBeGreaterThanOrEqual(2));
    expect(activeEvents.runtime.some((event) => event.kind === "turn_end")).toBe(false);
    await activeLane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("turns an activated process error into one killed crash completion", async () => {
    const lane = makeLane();
    const { errors, exits } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    service.process.emit("error", new Error("EIO"));

    await vi.waitFor(() => expect(killProcessTree).toHaveBeenCalledWith(service.process.pid, { graceMs: 0 }));
    expect(errors).toContainEqual(new Error("EIO"));
    expect(exits).toEqual([{ code: null, signal: null, reason: "runtime_exit" }]);
    service.process.emit("exit", 1, null);
    expect(exits).toHaveLength(1);
  });

  it("fails closed on unseen lower history events and sequence identity collisions", async () => {
    const lane = makeLane();
    const laneEvents = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.holdHistoryResponses = true;
    service.appendHistoryOnly("session.next.step.ended", {
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const catchingUp = (lane as unknown as { catchUpHistory(project: boolean): Promise<void> })
      .catchUpHistory(true);
    await vi.waitFor(() => expect(service.pendingHistoryResponses).toHaveLength(1));
    service.replayDurable({
      id: "evt_higher_first",
      type: "session.next.text.ended",
      durable: { aggregateID: service.sessionId, seq: 3, version: 1 },
      data: { sessionID: service.sessionId, assistantMessageID: "msg_assistant", textID: "text_3", text: "done" },
    });
    await vi.waitFor(() => expect(laneEvents.runtime).toContainEqual({ kind: "text", text: "done" }));
    service.releaseHistory();
    await expect(catchingUp).rejects.toThrow("OpenCode emitted an unseen durable event below the replay cursor");
    expect(laneEvents.runtime.some((event) => event.kind === "turn_end")).toBe(false);
    await lane.stop({ reason: "test", forceAfterMs: 0 });

    const collisionLane = makeLane();
    const collisionEvents = collectEvents(collisionLane);
    await collisionLane.start({ text: "root", terminalOwner: "msg_collision" });
    const collisionService = factories.at(-1)!.service!;
    const first = {
      id: "evt_seq_owner",
      type: "session.next.text.ended",
      durable: { aggregateID: collisionService.sessionId, seq: 2, version: 1 },
      data: { sessionID: collisionService.sessionId, assistantMessageID: "msg_assistant", textID: "text_2", text: "one" },
    };
    collisionService.replayDurable(first);
    collisionService.replayDurable({ ...first, id: "evt_seq_collision" });
    await vi.waitFor(() => {
      expect(collisionEvents.errors).toContainEqual(
        new Error("OpenCode durable event stream violated the v2 protocol"),
      );
    });
  });

  it("does not accept a root until the caller-id admission response arrives", async () => {
    const factory = new FakeOpenCodeFactory();
    const lane = makeLane(factory);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root_1" });
    await vi.waitFor(() => expect(factory.service?.prompts).toHaveLength(1));
    const service = factory.service!;
    killers.set(service.process.pid, () => service.close());
    service.holdPromptResponses = true;
    // The first request may already have responded; hold the next root instead.
    expect(await starting).toMatchObject({ ok: true, acceptedAs: "prompt", receipt: "msg_root_1" });
    const events = collectEvents(lane);
    service.finishSuccess();
    await waitForTurn(events.runtime, 1);

    const pending = lane.send({ text: "second", mode: "idle", terminalOwner: "msg_root_2" });
    await vi.waitFor(() => expect(service.pendingPromptResponses).toHaveLength(1));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    service.finishSuccess("before-receipt");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.runtime.filter((event) => event.kind === "turn_end")).toHaveLength(1);
    service.releasePrompt();
    await expect(pending).resolves.toMatchObject({ ok: true, acceptedAs: "prompt", receipt: "msg_root_2" });
    await waitForTurn(events.runtime, 2);
    expect(service.authHeaders.every((header) => header === `Basic ${Buffer.from("opencode:test-password").toString("base64")}`)).toBe(true);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("reuses one service for ten roots and never lets step/global-idle events own terminal", async () => {
    const factory = new FakeOpenCodeFactory();
    const lane = makeLane(factory);
    const { runtime } = collectEvents(lane);
    expect(await lane.start({ text: "identical", terminalOwner: "msg_root_1" })).toMatchObject({ ok: true });
    const service = factory.service!;
    killers.set(service.process.pid, () => service.close());
    service.replayDurable(service.durableEvents[0]!);

    for (let turn = 1; turn <= 10; turn += 1) {
      service.emitGlobalIdle();
      service.publish("session.next.step.ended", {
        assistantMessageID: `msg_intermediate_${turn}`,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(runtime.filter((event) => event.kind === "turn_end")).toHaveLength(turn - 1);
      service.finishSuccess("identical-final");
      await waitForTurn(runtime, turn);
      if (turn < 10) {
        await expect(lane.send({
          text: "identical",
          mode: "idle",
          terminalOwner: `msg_root_${turn + 1}`,
        })).resolves.toMatchObject({ ok: true, acceptedAs: "prompt" });
      }
    }

    expect(factory.spawnCount).toBe(1);
    expect(service.prompts).toHaveLength(10);
    expect(runtime.filter((event) => event.kind === "turn_end").map((event) => event.kind === "turn_end" && event.turnOwner))
      .toEqual(Array.from({ length: 10 }, (_, index) => `msg_root_${index + 1}`));
    await lane.stop({ reason: "test", forceAfterMs: 0 });
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(killProcessTree).toHaveBeenCalledWith(service.process.pid, { graceMs: 0 });
  });

  it("serializes ten busy steers and extends the terminal frontier by exact ids", async () => {
    const factory = new FakeOpenCodeFactory();
    const lane = makeLane(factory);
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factory.service!;
    killers.set(service.process.pid, () => service.close());
    service.holdPromptResponses = true;

    const admissions = Array.from({ length: 10 }, (_, index) => lane.send({
      text: `steer-${index + 1}`,
      mode: "busy" as const,
    }));
    await vi.waitFor(() => expect(service.pendingPromptResponses).toHaveLength(1));
    expect(service.prompts).toHaveLength(2);
    for (let index = 0; index < 10; index += 1) {
      service.releasePrompt();
      if (index < 9) await vi.waitFor(() => expect(service.pendingPromptResponses).toHaveLength(1));
    }
    const receipts = await Promise.all(admissions);
    expect(receipts.every((receipt) => receipt.ok && receipt.acceptedAs === "steer")).toBe(true);
    expect(service.prompts.slice(1).map((prompt) => (prompt.prompt as { text: string }).text))
      .toEqual(Array.from({ length: 10 }, (_, index) => `steer-${index + 1}`));
    expect(new Set(service.prompts.map((prompt) => prompt.id)).size).toBe(11);

    service.finishSuccess();
    await waitForTurn(runtime, 1);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("fails closed when active absence has only an intermediate step outcome", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    service.publish("session.next.step.ended", {
      assistantMessageID: "msg_intermediate",
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    service.active = false;
    await waitForTurn(runtime, 1);
    expect(runtime).toContainEqual({ kind: "error", message: "OpenCode drain settled without a durable turn outcome" });
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("fails closed on malformed admission and active-barrier responses", async () => {
    const admissionLane = makeLane();
    const admissionEvents = collectEvents(admissionLane);
    await admissionLane.start({ text: "root", terminalOwner: "msg_root" });
    const admissionService = factories.at(-1)!.service!;
    killers.set(admissionService.process.pid, () => admissionService.close());
    admissionService.malformedPromptReceipt = true;
    await expect(admissionLane.send({ text: "steer", mode: "busy" }))
      .rejects.toThrow("OpenCode prompt admission returned an invalid receipt");
    expect(admissionEvents.errors).toContainEqual(
      new Error("OpenCode prompt admission did not produce a valid durable receipt"),
    );

    const activeLane = makeLane();
    const activeEvents = collectEvents(activeLane);
    await activeLane.start({ text: "root", terminalOwner: "msg_root" });
    const activeService = factories.at(-1)!.service!;
    killers.set(activeService.process.pid, () => activeService.close());
    activeService.finishSuccess();
    activeService.malformedActiveResponse = true;
    await vi.waitFor(() => {
      expect(activeEvents.errors).toContainEqual(new Error("OpenCode active barrier violated the v2 protocol"));
    });
    expect(activeEvents.runtime.some((event) => event.kind === "turn_end")).toBe(false);
  });

  it("discards an absent response whose generation changed during the query", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    service.holdActiveResponses = true;
    service.finishSuccess("before-steer");
    await vi.waitFor(() => expect(service.pendingActiveResponses).toHaveLength(1));

    const steer = lane.send({ text: "late-steer", mode: "busy" });
    await expect(steer).resolves.toMatchObject({ ok: true, acceptedAs: "steer" });
    service.releaseActive();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.some((event) => event.kind === "turn_end")).toBe(false);

    service.holdActiveResponses = false;
    while (service.pendingActiveResponses.length > 0) service.releaseActive();
    service.finishSuccess("after-steer");
    await waitForTurn(runtime, 1);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("pauses admission across durable SSE disconnect and closes the replay gap before terminal", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    service.holdDurableConnections = true;
    service.disconnectDurable();
    await new Promise((resolve) => setTimeout(resolve, 15));

    const before = service.prompts.length;
    const steer = lane.send({ text: "after-gap", mode: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(service.prompts).toHaveLength(before);
    service.finishSuccess("history-only");
    expect(runtime.some((event) => event.kind === "turn_end")).toBe(false);

    service.releaseDurableConnections();
    await expect(steer).resolves.toMatchObject({ ok: true, acceptedAs: "steer" });
    service.finishSuccess("after-replay");
    await waitForTurn(runtime, 1);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("replies allow-once to live and recovered pending permissions", async () => {
    const lane = makeLane();
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    service.askPermission("per_live");
    await vi.waitFor(() => expect(service.permissionReplies).toContainEqual({ id: "per_live", reply: "once" }));
    service.pendingPermissions.push({
      id: "per_recovered",
      sessionID: service.sessionId,
      action: "read",
      resources: ["file"],
    });
    service.disconnectLive();
    await vi.waitFor(() => expect(service.permissionReplies).toContainEqual({ id: "per_recovered", reply: "once" }));
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("interrupts through HTTP and settles only after the active-absence barrier", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    expect(await lane.interrupt({ requestId: "interrupt-1" })).toBe(true);
    expect(service.interruptCount).toBe(1);
    await waitForTurn(runtime, 1);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("crashes an active turn when the service PID identity changes", async () => {
    const lane = makeLane();
    const { exits } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    service.process.pid += 1;
    await expect(lane.send({ text: "must-fail", mode: "busy" })).resolves.toMatchObject({ ok: false, reason: "closed" });
    await vi.waitFor(() => expect(exits).toContainEqual({ code: null, signal: null, reason: "runtime_exit" }));
  });

  it("reports a service crash during an active turn and rejects incompatible installed versions", async () => {
    const lane = makeLane();
    const { exits } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    killers.set(service.process.pid, () => service.close());
    service.close("SIGKILL");
    await vi.waitFor(() => expect(exits).toContainEqual({ code: null, signal: "SIGKILL", reason: "runtime_exit" }));

    const incompatibleFactory = new FakeOpenCodeFactory();
    incompatibleFactory.healthVersion = "1.17.21";
    const incompatible = makeLane(incompatibleFactory);
    await expect(incompatible.start({ text: "root", terminalOwner: "msg_bad_version" }))
      .resolves.toMatchObject({ ok: false, reason: "incompatible_configuration" });
  });

  it("fails a health timeout without admitting a prompt", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.healthStatus = 503;
    const lane = makeLane(factory, 40);
    await expect(lane.start({ text: "root", terminalOwner: "msg_timeout" }))
      .rejects.toThrow("OpenCode service readiness timed out");
    expect(factory.service?.prompts).toHaveLength(0);
  });

  it("resumes an existing cross-interface session without silently creating a replacement", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.existingSessions.add("ses_legacy_run");
    const lane = makeLane(factory);
    await expect(lane.start({
      text: "resume",
      sessionId: "ses_legacy_run",
      terminalOwner: "msg_resume",
    })).resolves.toMatchObject({ ok: true, receipt: "msg_resume" });
    expect(lane.currentSessionId).toBe("ses_legacy_run");
    expect(factory.service?.createCount).toBe(0);
    const service = factory.service!;
    killers.set(service.process.pid, () => service.close());
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("retries a bounded port bind race and fails a missing resume closed", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.failPortAttempts = 1;
    const lane = makeLane(factory);
    await expect(lane.start({ text: "root", terminalOwner: "msg_root" })).resolves.toMatchObject({ ok: true });
    expect(factory.spawnCount).toBe(2);
    const service = factory.service!;
    killers.set(service.process.pid, () => service.close());
    await lane.stop({ reason: "test", forceAfterMs: 0 });

    const missingFactory = new FakeOpenCodeFactory();
    const missing = makeLane(missingFactory);
    await expect(missing.start({ text: "root", sessionId: "ses_missing", terminalOwner: "msg_missing" }))
      .resolves.toMatchObject({ ok: false, reason: "reset_required" });
    expect(missingFactory.service?.createCount).toBe(0);
  });
});
