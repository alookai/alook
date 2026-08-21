import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdapterEvent,
  LaneAdmission,
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
  readonly stalledStreamResponses = new Set<ServerResponse>();
  readonly stalledJsonResponses = new Set<ServerResponse>();
  readonly stallJsonBodies = new Set<"health" | "history" | "prompt" | "active">();
  readonly pendingPermissions: Record<string, unknown>[] = [];
  readonly existingSessions = new Set<string>();
  active = false;
  holdPromptResponses = false;
  holdActiveResponses = false;
  holdHistoryResponses = false;
  holdDurableConnections = false;
  releaseDurableOnPrompt = false;
  failDurableConnections = 0;
  failLiveConnections = 0;
  stallDurableConnections = 0;
  stallLiveConnections = 0;
  malformedHistoryPage = false;
  stalledHistoryCursor = false;
  interruptStatus = 204;
  permissionReplyStatus = 204;
  resumeResponseId: string | undefined;
  createdSessionId: string | undefined;
  promptReceiptSeqOffset = 0;
  requiredPaths = REQUIRED_PATHS;
  durableConnectionAttempts = 0;
  liveConnectionAttempts = 0;
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
      ...this.stalledStreamResponses,
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

  publishLive(value: unknown): void {
    this.broadcast(this.liveClients, value);
  }

  publishRawDurable(data: string): void {
    for (const response of this.durableClients) response.write(`data: ${data}\n\n`);
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

  private stallStream(response: ServerResponse): void {
    this.stalledStreamResponses.add(response);
    response.on("close", () => this.stalledStreamResponses.delete(response));
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
      json(response, 200, { paths: Object.fromEntries(this.requiredPaths.map((item) => [item, { get: {} }])) });
      return;
    }
    if (request.method === "POST" && path === "/api/session") {
      this.createCount += 1;
      if (this.createdSessionId !== undefined) this.sessionId = this.createdSessionId;
      this.existingSessions.add(this.sessionId);
      json(response, 200, { data: { id: this.sessionId } });
      return;
    }
    if (request.method === "GET" && path !== "/api/session/active" && /^\/api\/session\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice("/api/session/".length));
      if (!this.existingSessions.has(id)) json(response, 404, { error: "missing" });
      else {
        this.sessionId = id;
        json(response, 200, { data: { id: this.resumeResponseId ?? id } });
      }
      return;
    }
    if (request.method === "POST" && /\/model$/.test(path)) {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && path === `/api/session/${this.sessionId}/event`) {
      this.durableConnectionAttempts += 1;
      if (this.stallDurableConnections > 0) {
        this.stallDurableConnections -= 1;
        this.stallStream(response);
        return;
      }
      if (this.failDurableConnections > 0) {
        this.failDurableConnections -= 1;
        json(response, 503, { error: "durable unavailable" });
        return;
      }
      if (this.holdDurableConnections) this.heldDurableClients.push(response);
      else this.openSse(response, this.durableClients);
      return;
    }
    if (request.method === "GET" && path === "/api/event") {
      this.liveConnectionAttempts += 1;
      if (this.stallLiveConnections > 0) {
        this.stallLiveConnections -= 1;
        this.stallStream(response);
        return;
      }
      if (this.failLiveConnections > 0) {
        this.failLiveConnections -= 1;
        json(response, 503, { error: "live unavailable" });
        return;
      }
      this.openSse(response, this.liveClients);
      return;
    }
    if (request.method === "GET" && path === `/api/session/${this.sessionId}/history`) {
      if (this.stallJson("history", response)) return;
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const respond = () => {
        if (this.malformedHistoryPage) {
          json(response, 200, { data: null, hasMore: "yes" });
          return;
        }
        if (this.stalledHistoryCursor) {
          json(response, 200, { data: [], hasMore: true });
          return;
        }
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
      if (this.releaseDurableOnPrompt) this.releaseDurableConnections();
      const admittedSeq = this.publish("session.next.prompt.admitted", { messageID: messageId, delivery, prompt: body.prompt });
      this.active = true;
      const respond = () => {
        if (this.stallJson("prompt", response)) return;
        json(response, 200, {
          data: {
            admittedSeq,
            ...(this.promptReceiptSeqOffset ? { admittedSeq: admittedSeq + this.promptReceiptSeqOffset } : {}),
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
      response.writeHead(this.interruptStatus).end();
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
      response.writeHead(this.permissionReplyStatus).end();
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
  holdDurableConnections = false;
  holdPromptResponses = false;
  releaseDurableOnPrompt = false;
  failDurableConnections = 0;
  failLiveConnections = 0;
  stallDurableConnections = 0;
  stallLiveConnections = 0;
  malformedHistoryPage = false;
  stalledHistoryCursor = false;
  interruptStatus = 204;
  permissionReplyStatus = 204;
  resumeResponseId: string | undefined;
  createdSessionId: string | undefined;
  promptReceiptSeqOffset = 0;
  requiredPaths = REQUIRED_PATHS;
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
    this.service.holdDurableConnections = this.holdDurableConnections;
    this.service.holdPromptResponses = this.holdPromptResponses;
    this.service.releaseDurableOnPrompt = this.releaseDurableOnPrompt;
    this.service.failDurableConnections = this.failDurableConnections;
    this.service.failLiveConnections = this.failLiveConnections;
    this.service.stallDurableConnections = this.stallDurableConnections;
    this.service.stallLiveConnections = this.stallLiveConnections;
    this.service.malformedHistoryPage = this.malformedHistoryPage;
    this.service.stalledHistoryCursor = this.stalledHistoryCursor;
    this.service.interruptStatus = this.interruptStatus;
    this.service.permissionReplyStatus = this.permissionReplyStatus;
    this.service.resumeResponseId = this.resumeResponseId;
    this.service.createdSessionId = this.createdSessionId;
    this.service.promptReceiptSeqOffset = this.promptReceiptSeqOffset;
    this.service.requiredPaths = this.requiredPaths;
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
  reconnectDelayMs = 5,
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
      reconnectDelayMs,
      startTimeoutMs,
      requestTimeoutMs,
    },
  );
  return lane;
}

function makeConfiguredLane(
  factory: FakeOpenCodeFactory,
  runtimeConfig: Record<string, unknown>,
  options: ConstructorParameters<typeof OpenCodeServiceLane>[2] = {},
): OpenCodeServiceLane {
  factories.push(factory);
  return new OpenCodeServiceLane(
    factory,
    fakeLaunchContext("opencode", process.cwd(), {
      config: { runtimeConfig: runtimeConfig as never },
    }),
    {
      password: "test-password",
      activePollMs: 5,
      reconnectDelayMs: 5,
      startTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      ...options,
    },
  );
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
  it("validates model, OpenAPI, session creation, and resumed identity responses", async () => {
    const invalidModel = makeConfiguredLane(new FakeOpenCodeFactory(), {
      model: { kind: "named", name: "missing-provider-separator" },
    });
    await expect(invalidModel.start({ text: "root", terminalOwner: "msg_invalid_model" }))
      .resolves.toMatchObject({ ok: false, reason: "incompatible_configuration" });

    const missingApiFactory = new FakeOpenCodeFactory();
    missingApiFactory.requiredPaths = REQUIRED_PATHS.slice(1);
    const missingApi = makeLane(missingApiFactory);
    await expect(missingApi.start({ text: "root", terminalOwner: "msg_missing_api" }))
      .resolves.toMatchObject({ ok: false, reason: "incompatible_configuration" });

    const invalidSessionFactory = new FakeOpenCodeFactory();
    invalidSessionFactory.createdSessionId = "invalid";
    const invalidSession = makeLane(invalidSessionFactory);
    await expect(invalidSession.start({ text: "root", terminalOwner: "msg_invalid_session" }))
      .rejects.toThrow("valid session id");

    const changedResumeFactory = new FakeOpenCodeFactory();
    changedResumeFactory.existingSessions.add("ses_resume");
    changedResumeFactory.resumeResponseId = "ses_different";
    const changedResume = makeLane(changedResumeFactory);
    await expect(changedResume.start({
      text: "root",
      sessionId: "ses_resume",
      terminalOwner: "msg_changed_resume",
    })).resolves.toMatchObject({ ok: false, reason: "reset_required" });

    const configuredResumeFactory = new FakeOpenCodeFactory();
    configuredResumeFactory.existingSessions.add("ses_configured");
    const configuredResume = makeConfiguredLane(configuredResumeFactory, {
      model: { kind: "named", name: "anthropic/claude-sonnet" },
    });
    await expect(configuredResume.start({
      text: "root",
      sessionId: "ses_configured",
      terminalOwner: "msg_configured",
    })).resolves.toMatchObject({ ok: true });
    await configuredResume.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("rejects missing process identity and an exhausted zero-attempt startup", async () => {
    const invalidProcess = Object.assign(new EventEmitter(), {
      pid: 0,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as MutableProcess;
    const invalidPidLane = new OpenCodeServiceLane(
      { spawnService: async () => ({ process: invalidProcess }) },
      fakeLaunchContext("opencode", process.cwd()),
      { password: "test-password", allocatePort: async () => 43_123, portAttempts: 1 },
    );
    await expect(invalidPidLane.start({ text: "root", terminalOwner: "msg_invalid_pid" }))
      .rejects.toThrow("did not expose a process id");

    const noAttemptLane = new OpenCodeServiceLane(
      { spawnService: vi.fn() },
      fakeLaunchContext("opencode", process.cwd()),
      { password: "test-password", portAttempts: 0 },
    );
    await expect(noAttemptLane.start({ text: "root", terminalOwner: "msg_no_attempt" }))
      .rejects.toThrow("failed to start");
  });

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

  it("settles stop when an in-flight spawn ultimately rejects", async () => {
    let rejectSpawn!: (error: Error) => void;
    const spawn = new Promise<never>((_resolve, reject) => { rejectSpawn = reject; });
    const lane = new OpenCodeServiceLane(
      { spawnService: async () => spawn },
      fakeLaunchContext("opencode", process.cwd()),
      { password: "test-password", allocatePort: async () => 43_123 },
    );
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });
    await Promise.resolve();
    const stopping = lane.stop({ reason: "test", forceAfterMs: 0 });
    rejectSpawn(new Error("spawn failed"));

    await expect(stopping).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow("spawn failed");
  });

  it.each([
    { stderr: "listen EADDRINUSE: address already in use", message: "port bind raced" },
    { stderr: "", message: "exited before readiness" },
  ])("classifies a startup process exit as $message", async ({ stderr, message }) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 41_999,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => true),
    }) as MutableProcess;
    const lane = new OpenCodeServiceLane(
      {
        spawnService: async () => {
          setTimeout(() => {
            if (stderr) (child.stderr as PassThrough).write(stderr);
            child.exitCode = 1;
            child.emit("exit", 1, null);
          }, 0);
          return { process: child };
        },
      },
      fakeLaunchContext("opencode", process.cwd()),
      { password: "test-password", allocatePort: async () => 43_123, portAttempts: 1, startTimeoutMs: 100 },
    );

    await expect(lane.start({ text: "root", terminalOwner: "msg_root" })).rejects.toThrow(message);
  });

  it("kills the detached service group even after its root handle is already terminal", async () => {
    const factory = new FakeOpenCodeFactory();
    const lane = makeLane(factory);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factory.service!;
    service.process.exitCode = 0;

    await lane.stop({ reason: "test", forceAfterMs: 0 });

    expect(killProcessTree).toHaveBeenCalledWith(service.process.pid, { graceMs: 0 });
  });

  it("admits the first prompt when durable SSE headers wait for its first event", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.holdDurableConnections = true;
    factory.releaseDurableOnPrompt = true;
    const lane = makeLane(factory);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });

    await vi.waitFor(() => expect(factory.service?.prompts).toHaveLength(1));
    await expect(starting).resolves.toMatchObject({ ok: true, acceptedAs: "prompt", receipt: "msg_root" });
    expect(factory.service?.durableClients.size).toBe(1);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("moves startup readiness to the next live gate after a pre-open transport failure", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.failLiveConnections = 1;
    const lane = makeLane(factory);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });

    await vi.waitFor(() => expect(factory.service?.prompts).toHaveLength(1));
    await expect(starting).resolves.toMatchObject({ ok: true, acceptedAs: "prompt" });
    expect(factory.service?.liveConnectionAttempts).toBeGreaterThanOrEqual(2);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("retries a live header deadline without cancelling lifecycle readiness", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.stallLiveConnections = 1;
    const lane = makeLane(factory, 1_000, 1_000);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });

    await vi.waitFor(() => expect(factory.service?.liveConnectionAttempts).toBeGreaterThanOrEqual(2), {
      timeout: 2_500,
    });
    await vi.waitFor(() => expect(factory.service?.prompts).toHaveLength(1));
    await expect(starting).resolves.toMatchObject({ ok: true, acceptedAs: "prompt" });
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("does not retry a stalled stream after lifecycle stop aborts it", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.stallLiveConnections = 1;
    const lane = makeLane(factory, 1_000, 1_000);
    const { runtime } = collectEvents(lane);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });
    await vi.waitFor(() => expect(factory.service?.liveConnectionAttempts).toBe(1));

    await lane.stop({ reason: "test", forceAfterMs: 0 });
    await expect(starting).rejects.toThrow("OpenCode service lane stopped");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(factory.service?.liveConnectionAttempts).toBe(1);
    expect(runtime.filter((event) => event.kind === "runtime_metric")).toHaveLength(0);
  });

  it("aborts established live and durable streams on stop without process teardown", async () => {
    const factory = new FakeOpenCodeFactory();
    const lane = makeLane(factory, 1_000, 1_000);
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factory.service!;
    await vi.waitFor(() => {
      expect(service.liveClients.size).toBe(1);
      expect(service.durableClients.size).toBe(1);
    });
    killProcessTree.mockImplementation(async () => {});

    await lane.stop({ reason: "test", forceAfterMs: 0 });
    await vi.waitFor(() => {
      expect(service.liveClients.size).toBe(0);
      expect(service.durableClients.size).toBe(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(service.liveConnectionAttempts).toBe(1);
    expect(service.durableConnectionAttempts).toBe(1);
    expect(runtime.filter((event) => event.kind === "runtime_metric")).toHaveLength(0);
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

    const promptLane = makeLane(new FakeOpenCodeFactory(), 1_000, 1_000);
    const promptEvents = collectEvents(promptLane);
    await promptLane.start({ text: "root", terminalOwner: "msg_prompt" });
    const promptService = factories.at(-1)!.service!;
    promptService.stallJsonBodies.add("prompt");
    await expect(promptLane.send({ text: "steer", mode: "busy" }))
      .rejects.toThrow("OpenCode prompt admission response timed out");
    expect(promptEvents.errors).toContainEqual(
      new Error("OpenCode prompt admission did not produce a valid durable receipt"),
    );

    const activeLane = makeLane(new FakeOpenCodeFactory(), 1_000, 1_000);
    const activeEvents = collectEvents(activeLane);
    await activeLane.start({ text: "root", terminalOwner: "msg_active" });
    const activeService = factories.at(-1)!.service!;
    activeService.stallJsonBodies.add("active");
    activeService.finishSuccess();
    await vi.waitFor(() => expect(activeService.stalledJsonResponses.size).toBe(1));
    const stalledActiveResponse = [...activeService.stalledJsonResponses][0]!;
    const activeCountAtStall = activeService.activeCount;
    await vi.waitFor(() => expect(activeService.stalledJsonResponses.has(stalledActiveResponse)).toBe(false), {
      timeout: 2_500,
    });
    await vi.waitFor(() => expect(activeService.activeCount).toBeGreaterThan(activeCountAtStall), {
      timeout: 2_500,
    });
    expect(activeEvents.runtime.some((event) => event.kind === "turn_end")).toBe(false);
    await activeLane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("keeps an external stop abort distinct from a JSON response deadline", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.stallJsonBodies.add("history");
    const lane = makeLane(factory, 1_000, 1_000);
    const starting = lane.start({ text: "root", terminalOwner: "msg_stopped" });
    await vi.waitFor(() => expect(factory.service?.stalledJsonResponses.size).toBe(1));

    const stopping = lane.stop({ reason: "test", forceAfterMs: 0 });
    const error = await starting.catch((value: unknown) => value);
    await stopping;

    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toMatchObject({ message: "OpenCode session history response timed out" });
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
    service.process.emit("error", new Error("duplicate"));
    expect(exits).toHaveLength(1);
  });

  it("keeps process output observational and surfaces startup process errors", async () => {
    const factory = new FakeOpenCodeFactory();
    const observed: string[] = [];
    const lane = makeConfiguredLane(factory, { model: { kind: "default" } }, {
      onRawStdoutLine: (line) => {
        observed.push(line);
        if (line === "throw") throw new Error("observer failure");
      },
    });
    const stderr: string[] = [];
    lane.on("stderr", (text) => stderr.push(text));
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factory.service!;
    (service.process.stdout as PassThrough).write("one\n\nthrow\npartial");
    (service.process.stdout as PassThrough).write("-line\n");
    (service.process.stderr as PassThrough).write("service warning");
    expect(observed).toEqual(["one", "throw", "partial-line"]);
    expect(stderr).toEqual(["service warning"]);
    await lane.stop({ reason: "test", forceAfterMs: 0 });

    const startingFactory = new FakeOpenCodeFactory();
    startingFactory.healthStatus = 503;
    const startingLane = makeLane(startingFactory, 1_000);
    const starting = startingLane.start({ text: "root", terminalOwner: "msg_start_error" });
    await vi.waitFor(() => expect(startingFactory.service).toBeDefined());
    startingFactory.service!.process.emit("error", new Error("startup EIO"));
    await expect(starting).rejects.toThrow("startup EIO");
  });

  it("rejects an interrupt failure without exposing its request id", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.interruptStatus = 503;
    const lane = makeLane(factory);
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });

    await expect(lane.interrupt({ requestId: "not safe to show" })).rejects.toThrow("HTTP 503");
    expect(runtime).toContainEqual({
      kind: "runtime_diagnostic",
      severity: "error",
      source: "opencode.v2",
      message: "OpenCode interrupt failed (unknown)",
    });
  });

  it("fails startup if the process identity changes after prompt admission", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.holdPromptResponses = true;
    const lane = makeLane(factory);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });
    await vi.waitFor(() => expect(factory.service?.pendingPromptResponses).toHaveLength(1));
    const service = factory.service!;
    service.process.pid += 1;
    service.releasePrompt();
    await expect(starting).rejects.toThrow("identity changed during startup");
  });

  it("fails closed on unseen lower history events and sequence identity collisions", async () => {
    const lane = makeLane();
    const laneEvents = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    const laneState = lane as unknown as {
      durableGap: boolean;
      historyTail: Promise<void>;
      catchUpHistory(project: boolean): Promise<void>;
    };
    await vi.waitFor(() => expect(laneState.durableGap).toBe(false));
    await laneState.historyTail;
    service.holdHistoryResponses = true;
    service.appendHistoryOnly("session.next.step.ended", {
      assistantMessageID: "msg_assistant",
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const catchingUp = laneState.catchUpHistory(true);
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

  it("rejects malformed history pages and a paginated cursor that cannot advance", async () => {
    const malformedFactory = new FakeOpenCodeFactory();
    malformedFactory.malformedHistoryPage = true;
    const malformed = makeLane(malformedFactory);
    await expect(malformed.start({ text: "root", terminalOwner: "msg_malformed_history" }))
      .rejects.toThrow("invalid page");

    const stalledFactory = new FakeOpenCodeFactory();
    stalledFactory.stalledHistoryCursor = true;
    const stalled = makeLane(stalledFactory);
    await expect(stalled.start({ text: "root", terminalOwner: "msg_stalled_history" }))
      .rejects.toThrow("cursor did not advance");
  });

  it("rejects a prompt receipt whose durable sequence disagrees", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.promptReceiptSeqOffset = 1;
    factory.holdPromptResponses = true;
    const lane = makeLane(factory);
    const { errors } = collectEvents(lane);
    const starting = lane.start({ text: "root", terminalOwner: "msg_root" });
    await vi.waitFor(() => expect(factory.service?.pendingPromptResponses).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    factory.service!.releasePrompt();
    await expect(starting)
      .rejects.toThrow("did not match its receipt");
    expect(errors).toContainEqual(
      new Error("OpenCode prompt admission did not produce a valid durable receipt"),
    );
  });

  it("fails closed when post-admission history catch-up violates the protocol", async () => {
    const factory = new FakeOpenCodeFactory();
    const lane = makeLane(factory);
    const { errors } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factory.service!;
    service.holdPromptResponses = true;

    const steering = lane.send({ text: "steer", mode: "busy" });
    await vi.waitFor(() => expect(service.pendingPromptResponses).toHaveLength(1));
    service.disconnectDurable();
    service.malformedHistoryPage = true;
    service.releasePrompt();
    await expect(steering).resolves.toMatchObject({ ok: true, acceptedAs: "steer" });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]!.message).toMatch(/OpenCode .* violated the v2 protocol/);
  });

  it("routes a background admission catch-up protocol error through lane failure", async () => {
    const lane = makeLane();
    const { errors } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const internals = lane as unknown as {
      sessionId: string;
      handleDurableEvent(value: unknown, project: boolean): Promise<number>;
      fetchJsonWithTimeout(path: string, init: RequestInit, operation: string): Promise<{ response: Response; body: unknown }>;
      catchUpHistory(project: boolean): Promise<void>;
      queueAdmission(text: string, delivery: "queue" | "steer", messageId: string): Promise<LaneAdmission>;
    };
    const protocolError = await internals.handleDurableEvent({ invalid: true }, true)
      .catch((error: unknown) => error as Error);
    const originalFetch = internals.fetchJsonWithTimeout.bind(internals);
    internals.fetchJsonWithTimeout = async (path, init, operation) => path.endsWith("/prompt")
      ? {
          response: new Response("", { status: 200 }),
          body: {
            data: {
              id: "msg_background",
              sessionID: internals.sessionId,
              delivery: "steer",
              admittedSeq: 9_999,
            },
          },
        }
      : originalFetch(path, init, operation);
    internals.catchUpHistory = async () => { throw protocolError; };

    await expect(internals.queueAdmission("steer", "steer", "msg_background"))
      .resolves.toMatchObject({ ok: true, acceptedAs: "steer" });
    await vi.waitFor(() => expect(errors).toContainEqual(
      new Error("OpenCode session history violated the v2 protocol"),
    ));
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

  it("projects the complete durable event vocabulary and fails the final turn exactly once", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;

    service.publish("session.next.step.started", { assistantMessageID: "msg_assistant" });
    service.publish("session.next.reasoning.ended", {
      assistantMessageID: "msg_assistant",
      textID: "reasoning_1",
      text: "considering",
    });
    service.publish("session.next.tool.called", {
      assistantMessageID: "msg_assistant",
      callID: "call_1",
      tool: "Read",
      input: { path: "README.md" },
    });
    service.publish("session.next.tool.success", {
      assistantMessageID: "msg_assistant",
      callID: "call_1",
    });
    service.publish("session.next.tool.failed", {
      assistantMessageID: "msg_assistant",
      callID: "call_unknown",
    });
    service.publish("session.next.compaction.started", { assistantMessageID: "msg_assistant" });
    service.publish("session.next.compaction.ended", { assistantMessageID: "msg_assistant" });
    service.publish("session.next.step.failed", {
      assistantMessageID: "msg_assistant",
      error: { message: "secret vendor detail" },
    });
    service.publish("session.next.step.failed", {
      assistantMessageID: "msg_assistant",
      error: {},
    });
    service.active = false;

    await waitForTurn(runtime, 1);
    expect(runtime).toContainEqual({ kind: "thinking", text: "" });
    expect(runtime).toContainEqual({ kind: "thinking", text: "considering" });
    expect(runtime).toContainEqual({ kind: "tool_call", name: "Read", input: { path: "README.md" } });
    expect(runtime).toContainEqual({ kind: "tool_output", name: "Read" });
    expect(runtime).toContainEqual({ kind: "tool_output", name: "OpenCode tool" });
    expect(runtime).toContainEqual({ kind: "compaction_started" });
    expect(runtime).toContainEqual({ kind: "compaction_finished" });
    expect(runtime).toContainEqual({ kind: "error", message: "OpenCode reported an inconsistent turn outcome" });
    expect(JSON.stringify(runtime)).not.toContain("secret vendor detail");
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("sorts multiple durable outcomes and uses the latest terminal fact", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    service.publish("session.next.step.ended", { assistantMessageID: "msg_one", finish: "stop" });
    service.publish("session.next.step.ended", { assistantMessageID: "msg_two", finish: "length" });
    service.active = false;

    await waitForTurn(runtime, 1);
    expect(runtime.some((event) => event.kind === "error")).toBe(false);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("rechecks the durable frontier after the active-absence history barrier", async () => {
    const lane = new OpenCodeServiceLane(
      { spawnService: vi.fn() },
      fakeLaunchContext("opencode", process.cwd()),
      { password: "test-password" },
    );
    const { runtime } = collectEvents(lane);
    const child = Object.assign(new EventEmitter(), {
      pid: 42_100,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as MutableProcess;
    const internals = lane as unknown as {
      activeRoot: {
        receipt: string;
        baselineSeq: number;
        frontier: Map<string, number>;
        durableAdmissions: Map<string, number>;
        observedAdmissions: Set<string>;
        outcomes: unknown[];
        generation: number;
        pendingAdmissions: number;
        interrupted: boolean;
        interruptPending: boolean;
      };
      process: MutableProcess;
      identity: { generation: number; process: MutableProcess; pid: number };
      sessionId: string;
      ready: boolean;
      stopping: boolean;
      lastDurableSeq: number;
      durableGap: boolean;
      evaluationTimer?: ReturnType<typeof setTimeout>;
      evaluating: boolean;
      fetchJsonWithTimeout(): Promise<{ response: Response; body: unknown }>;
      catchUpHistory(project: boolean): Promise<void>;
      barrierStillCurrent(): boolean;
      evaluateTerminal(): Promise<void>;
    };
    internals.process = child;
    internals.identity = { generation: 1, process: child, pid: child.pid };
    internals.sessionId = "ses_barrier";
    internals.ready = true;
    internals.stopping = false;
    internals.lastDurableSeq = 1;
    internals.durableGap = false;
    internals.activeRoot = {
      receipt: "msg_root",
      baselineSeq: 0,
      frontier: new Map([["msg_root", 1]]),
      durableAdmissions: new Map([["msg_root", 1]]),
      observedAdmissions: new Set(["msg_root"]),
      outcomes: [],
      generation: 0,
      pendingAdmissions: 0,
      interrupted: false,
      interruptPending: false,
    };
    internals.evaluating = false;
    internals.fetchJsonWithTimeout = async () => ({
      response: new Response("", { status: 200 }),
      body: { data: {} },
    });
    internals.catchUpHistory = async () => {
      internals.activeRoot.observedAdmissions.clear();
      internals.durableGap = false;
    };
    internals.barrierStillCurrent = () => true;
    await internals.evaluateTerminal();

    expect(runtime.some((event) => event.kind === "turn_end")).toBe(false);
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("rejects malformed durable and live protocol values before they can project", async () => {
    const lane = makeLane();
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    const internals = lane as unknown as {
      handleDurableEvent(value: unknown, project: boolean): Promise<number>;
      handleLiveEvent(value: unknown): Promise<void>;
    };

    await expect(internals.handleDurableEvent({ type: "bad" }, true))
      .rejects.toThrow("invalid durable event");
    const replayed = {
      id: "evt_replayed",
      type: "session.next.text.ended",
      durable: { aggregateID: service.sessionId, seq: 500, version: 1 },
      data: { sessionID: service.sessionId, text: "one" },
    };
    await internals.handleDurableEvent(replayed, true);
    await expect(internals.handleDurableEvent({
      ...replayed,
      durable: { aggregateID: service.sessionId, seq: 501, version: 1 },
    }, true)).rejects.toThrow("different sequence");
    await expect(internals.handleDurableEvent({
      id: "evt_missing_finish",
      type: "session.next.step.ended",
      durable: { aggregateID: service.sessionId, seq: 502, version: 1 },
      data: { sessionID: service.sessionId },
    }, true)).rejects.toThrow("omitted its finish reason");
    await expect(internals.handleLiveEvent({
      type: "permission.v2.asked",
      data: { sessionID: service.sessionId, id: "malformed" },
    })).rejects.toThrow("malformed permission request");
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it.each([
    { kind: "durable", publish: (service: FakeOpenCodeService) => service.publishRawDurable("{not-json}") },
    {
      kind: "live",
      publish: (service: FakeOpenCodeService) => service.publishLive({
        type: "permission.v2.asked",
        data: { sessionID: service.sessionId, id: "malformed" },
      }),
    },
  ])("fails the $kind stream closed on a protocol violation", async ({ publish }) => {
    const lane = makeLane();
    const { errors } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    publish(factories.at(-1)!.service!);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await lane.stop({ reason: "test", forceAfterMs: 0 });
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
    await vi.waitFor(() => expect(runtime.filter((event) => event.kind === "runtime_metric")).toEqual([{
      kind: "runtime_metric",
      name: "sse_reconnect",
      increment: 1,
    }]));

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

  it("moves a paused admission to the next durable gate after a pre-open transport failure", async () => {
    const lane = makeLane(new FakeOpenCodeFactory(), 1_000, 1_000, 100);
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    service.failDurableConnections = 1;
    service.holdDurableConnections = true;
    service.disconnectDurable();
    await vi.waitFor(() => expect(runtime.filter((event) => event.kind === "runtime_metric")).toHaveLength(1));

    const steer = lane.send({ text: "after-gap", mode: "busy" });
    await vi.waitFor(() => expect(service.durableConnectionAttempts).toBeGreaterThanOrEqual(3));
    service.finishSuccess("history-only");
    service.releaseDurableConnections();

    await expect(steer).resolves.toMatchObject({ ok: true, acceptedAs: "steer" });
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("retries a durable header deadline while keeping later admission paused", async () => {
    const lane = makeLane(new FakeOpenCodeFactory(), 1_000, 100, 50);
    const { runtime } = collectEvents(lane);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factories.at(-1)!.service!;
    service.stallDurableConnections = 1;
    service.disconnectDurable();
    await vi.waitFor(() => expect(runtime.filter((event) => event.kind === "runtime_metric")).toHaveLength(1));

    const steer = lane.send({ text: "after-deadline", mode: "busy" });
    await vi.waitFor(() => expect(service.durableConnectionAttempts).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(service.prompts).toHaveLength(1);
    await vi.waitFor(() => expect(service.durableConnectionAttempts).toBeGreaterThanOrEqual(3));

    await expect(steer).resolves.toMatchObject({ ok: true, acceptedAs: "steer" });
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("replies allow-once to live and recovered pending permissions", async () => {
    const lane = makeLane();
    const { runtime } = collectEvents(lane);
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
    await vi.waitFor(() => expect(runtime.filter((event) => event.kind === "runtime_metric")).toEqual([{
      kind: "runtime_metric",
      name: "sse_reconnect",
      increment: 1,
    }]));
    await vi.waitFor(() => expect(service.permissionReplies).toContainEqual({ id: "per_recovered", reply: "once" }));
    await lane.stop({ reason: "test", forceAfterMs: 0 });
  });

  it("treats an already-removed permission reply as handled", async () => {
    const factory = new FakeOpenCodeFactory();
    factory.permissionReplyStatus = 404;
    const lane = makeLane(factory);
    await lane.start({ text: "root", terminalOwner: "msg_root" });
    const service = factory.service!;
    service.askPermission("per_removed");
    await vi.waitFor(() => expect(service.permissionReplies).toContainEqual({ id: "per_removed", reply: "once" }));
    service.askPermission("per_removed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.permissionReplies.filter((item) => item.id === "per_removed")).toHaveLength(1);
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

  it("normalizes low-level HTTP, JSON, and stopped-stream failures", async () => {
    const ctx = fakeLaunchContext("opencode", process.cwd(), {
      config: { runtimeConfig: { model: { kind: "default" } } },
    });
    const factory = new FakeOpenCodeFactory();
    const httpLane = new OpenCodeServiceLane(factory, ctx, {
      password: "test-password",
      fetch: vi.fn(async () => new Response("", { status: 503 })),
    });
    const http = httpLane as unknown as {
      baseUrl: string;
      requestNoContent(path: string, method: "POST", body: Record<string, unknown> | undefined, operation: string): Promise<void>;
    };
    http.baseUrl = "http://127.0.0.1";
    await expect(http.requestNoContent("/fail", "POST", undefined, "test operation"))
      .rejects.toThrow("OpenCode test operation failed with HTTP 503");

    const jsonLane = new OpenCodeServiceLane(factory, ctx, {
      password: "test-password",
      fetch: vi.fn(async () => new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    });
    const json = jsonLane as unknown as {
      baseUrl: string;
      fetchJsonWithTimeout(path: string, init: RequestInit, operation: string): Promise<unknown>;
    };
    json.baseUrl = "http://127.0.0.1";
    await expect(json.fetchJsonWithTimeout("/bad-json", { method: "GET" }, "test JSON"))
      .rejects.toThrow("OpenCode test JSON returned invalid JSON");

    const rejectedLane = new OpenCodeServiceLane(factory, ctx, {
      password: "test-password",
      fetch: vi.fn(async () => Promise.reject("network rejected")),
    });
    const rejected = rejectedLane as unknown as {
      baseUrl: string;
      fetchWithTimeout(path: string, init: RequestInit, operation: string): Promise<Response>;
    };
    rejected.baseUrl = "http://127.0.0.1";
    await expect(rejected.fetchWithTimeout("/rejected", { method: "GET" }, "test fetch"))
      .rejects.toThrow("OpenCode test fetch request failed");

    const stoppedLane = new OpenCodeServiceLane(factory, ctx, { password: "test-password" });
    await stoppedLane.stop({ reason: "test", forceAfterMs: 0 });
    const stopped = stoppedLane as unknown as {
      waitForLiveStream(): Promise<void>;
      waitForStreams(): Promise<void>;
      protocolFailure(message: string): void;
    };
    await expect(stopped.waitForLiveStream()).rejects.toThrow("stopped before stream recovery");
    await expect(stopped.waitForStreams()).rejects.toThrow("stopped before stream recovery");
    expect(() => stopped.protocolFailure("already stopped")).not.toThrow();
  });

  it("cleans defensive no-pid, stream-failure, replay, and admission paths", async () => {
    const ctx = fakeLaunchContext("opencode", process.cwd(), {
      config: { runtimeConfig: { model: { kind: "default" } } },
    });
    const processWithoutPid = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as MutableProcess;
    const stopLane = new OpenCodeServiceLane({ spawnService: vi.fn() }, ctx, { password: "test-password" });
    (stopLane as unknown as { process: MutableProcess }).process = processWithoutPid;
    await stopLane.stop({ signal: "SIGKILL", forceAfterMs: 0 });
    expect(processWithoutPid.kill).toHaveBeenCalledWith("SIGKILL");

    const streamLane = new OpenCodeServiceLane({ spawnService: vi.fn() }, ctx, { password: "test-password" });
    const streamErrors: Error[] = [];
    streamLane.on("error", (error) => streamErrors.push(error instanceof Error ? error : new Error(String(error))));
    (streamLane as unknown as { streamFailure(kind: "durable" | "live", error: unknown): void })
      .streamFailure("durable", new Error("stream task failed"));
    expect(streamErrors).toEqual([new Error("OpenCode durable stream stopped unexpectedly")]);

    const replayLane = new OpenCodeServiceLane({ spawnService: vi.fn() }, ctx, { password: "test-password" });
    const replay = replayLane as unknown as {
      sessionId: string;
      handleDurableEvent(value: unknown, project: boolean): Promise<number>;
      queueAdmission(text: string, delivery: "queue" | "steer", messageId: string): Promise<LaneAdmission>;
      beginRoot(input: { text: string; terminalOwner?: string }): Promise<LaneAdmission>;
      activeRoot: unknown;
    };
    replay.sessionId = "ses_replay";
    await expect(replay.handleDurableEvent({
      id: "evt_replay",
      type: "session.next.text.ended",
      durable: { aggregateID: "ses_replay", seq: 1, version: 1 },
      data: { sessionID: "ses_replay", text: "not projected" },
    }, false)).resolves.toBe(1);

    replay.activeRoot = {
      receipt: "msg_closed",
      baselineSeq: 0,
      frontier: new Map(),
      durableAdmissions: new Map(),
      observedAdmissions: new Set(),
      outcomes: [],
      generation: 0,
      pendingAdmissions: 0,
      interrupted: false,
      interruptPending: false,
    };
    await expect(replay.queueAdmission("closed", "queue", "msg_closed"))
      .resolves.toEqual({ ok: false, reason: "closed" });

    const originalQueue = replay.queueAdmission.bind(replay);
    replay.queueAdmission = async () => { throw new Error("admission failed"); };
    await expect(replay.beginRoot({ text: "root", terminalOwner: "msg_root" }))
      .rejects.toThrow("admission failed");
    expect(replay.activeRoot).toBeNull();
    replay.queueAdmission = originalQueue;
  });
});
