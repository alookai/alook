import type {
  AdapterEvent,
  LaneAdmission,
  LaneInterruptInput,
  LaneSendInput,
  LaneStartInput,
  LaneStopInput,
} from "../../internal/adapter.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import { scrubDriverErrorMessage } from "../../internal/errors.js";
import { resolveOpenCodeCompatibility } from "./compatibility.js";
import {
  OpenCodeHttpError,
  OpenCodeProtocolError,
  OpenCodeServiceLane,
  record,
} from "./service-lane.js";

type JsonRecord = Record<string, unknown>;

interface Root {
  readonly receipt: string;
  readonly baseline: string | null;
  readonly inputs: Set<string>;
  generation: number;
  pending: number;
}

export class OpenCodeV2ServiceLane extends OpenCodeServiceLane {
  private root: Root | null = null;
  private v2AdmissionTail: Promise<void> = Promise.resolve();
  private v2EvaluationTimer?: ReturnType<typeof setTimeout>;
  private v2Evaluating = false;
  private readonly projectedMessages = new Set<string>();
  private readonly liveTools = new Map<string, { name: string; called: boolean }>();
  private readonly settledTools = new Set<string>();
  private readonly usage = new SettledUsageProjector();

  protected override get healthPath(): string { return "/api/info"; }

  protected override get openApiPath(): string { return "/openapi.json"; }

  protected override acceptsHealth(health: JsonRecord | null): boolean {
    if (typeof health?.version !== "string" || !Number.isInteger(health.pid) || Number(health.pid) < 1) return false;
    try { return resolveOpenCodeCompatibility(health.version).major === 2; } catch { return false; }
  }

  protected override get requiredApiPaths(): readonly string[] {
    return [
      "/api/session",
      "/api/session/active",
      "/api/session/{sessionID}",
      "/api/session/{sessionID}/prompt",
      "/api/session/{sessionID}/inbox",
      "/api/session/{sessionID}/message",
      "/api/session/{sessionID}/message/{messageID}",
      "/api/session/{sessionID}/interrupt",
      "/api/session/{sessionID}/model",
      "/api/session/{sessionID}/permission",
      "/api/session/{sessionID}/permission/{requestID}/reply",
      "/api/event",
    ];
  }

  protected override get selectedModel(): JsonRecord | undefined {
    const model = super.selectedModel;
    if (typeof model?.id !== "string") return model;
    const hash = model.id.lastIndexOf("#");
    return hash > 0 && hash < model.id.length - 1
      ? { ...model, id: model.id.slice(0, hash), variant: model.id.slice(hash + 1) }
      : model;
  }

  protected override get permissionEventType(): string { return "permission.asked"; }

  protected override get permissionReply(): JsonRecord { return { decision: "once" }; }

  protected override protocolFailure(message: string, cause?: unknown): void {
    super.protocolFailure(cause === undefined ? message : `${message}: ${scrubDriverErrorMessage(cause)}`);
  }

  protected override async primeHistory(): Promise<void> {}

  protected override startStreams(): void {
    const identity = this.identity!;
    this.liveTask = this.runLiveStream(identity).catch((error: unknown) => {
      if (!this.stopping) this.protocolFailure("OpenCode CLI v2 live stream failed", error);
    });
  }

  protected override async recoverPendingPermissions(): Promise<void> {
    await super.recoverPendingPermissions();
    const root = this.root;
    if (root) for (const message of await this.messagesAfter(root)) this.projectTools(message);
    this.schedule();
  }

  protected override async handleLiveEvent(value: unknown): Promise<void> {
    await super.handleLiveEvent(value);
    const event = record(value);
    const data = record(event?.data);
    if (data?.sessionID !== this.sessionId || !this.root) return;
    switch (event?.type) {
      case "session.step.started":
        this.events.emit("runtime_event", {
          kind: "internal_progress", source: "opencode.service", itemType: "step_started",
        } satisfies AdapterEvent);
        break;
      case "session.tool.input.started": {
        const key = this.toolKey(data.assistantMessageID, data.id);
        if (key && typeof data.name === "string" && !this.liveTools.has(key) && !this.settledTools.has(key)) {
          this.liveTools.set(key, { name: data.name, called: false });
        }
        break;
      }
      case "session.tool.called":
        this.projectTool(data);
        break;
      case "session.tool.success":
      case "session.tool.failed": {
        this.finishTool(this.toolKey(data.assistantMessageID, data.id));
        break;
      }
      case "session.compaction.started":
        this.events.emit("runtime_event", { kind: "compaction_started" } satisfies AdapterEvent);
        break;
      case "session.compaction.failed":
      case "session.compaction.ended":
        this.events.emit("runtime_event", { kind: "compaction_finished" } satisfies AdapterEvent);
        break;
      default:
        break;
    }
    this.schedule();
  }

  override async send(input: LaneSendInput): Promise<LaneAdmission> {
    if (!this.ready || this.stopping || !this.sessionId || !this.identityMatches()) return { ok: false, reason: "closed" };
    if (input.mode === "idle") {
      if (this.root) return { ok: false, reason: "runtime_busy" };
      return this.beginRoot(input);
    }
    const root = this.root;
    if (!root) return { ok: false, reason: "not_ready" };
    return this.admit(input.text, "steer", this.newMessageId(), root);
  }

  protected override async beginRoot(input: LaneStartInput): Promise<LaneAdmission> {
    const page = await this.messagePage(undefined, 1);
    if (this.stopping || !this.identityMatches()) return { ok: false, reason: "closed" };
    const receipt = input.terminalOwner?.startsWith("msg_") ? input.terminalOwner : this.newMessageId();
    const root: Root = {
      receipt,
      baseline: typeof page.data[0]?.id === "string" ? page.data[0].id : null,
      inputs: new Set(), generation: 0, pending: 0,
    };
    this.root = root;
    return this.admit(input.text, "queue", receipt, root);
  }

  private admit(text: string, delivery: "queue" | "steer", id: string, root: Root): Promise<LaneAdmission> {
    root.generation += 1;
    root.pending += 1;
    const run = this.v2AdmissionTail.then(async (): Promise<LaneAdmission> => {
      await this.waitForLiveStream();
      if (this.root !== root || this.stopping || !this.identityMatches()) return { ok: false, reason: "closed" };
      const { response, body } = await this.fetchJsonWithTimeout(
        `/api/session/${encodeURIComponent(this.sessionId!)}/prompt`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, text, delivery, resume: true }) },
        "prompt admission",
      );
      if (!response.ok) throw new OpenCodeHttpError(response.status, "prompt admission");
      const input = record(record(body)?.data);
      if (input?.id !== id || input.sessionID !== this.sessionId || input.type !== "user" || input.delivery !== delivery) {
        throw new OpenCodeProtocolError("OpenCode CLI v2 returned an invalid prompt receipt");
      }
      if (this.root !== root || this.stopping || !this.identityMatches()) return { ok: false, reason: "closed" };
      root.inputs.add(id);
      return { ok: true, acceptedAs: delivery === "steer" ? "steer" : "prompt", receipt: id };
    }).catch((error: unknown) => {
      if (this.root === root && !this.stopping) this.protocolFailure("OpenCode CLI v2 prompt admission failed", error);
      throw error;
    }).finally(() => { root.pending -= 1; this.schedule(); });
    this.v2AdmissionTail = run.then(() => {}, () => {});
    return run;
  }

  private async messagePage(cursor?: string, limit = 100): Promise<{ data: JsonRecord[]; next?: string }> {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : { order: "desc" }) });
    const { response, body } = await this.fetchJsonWithTimeout(
      `/api/session/${encodeURIComponent(this.sessionId!)}/message?${query}`,
      { method: "GET" }, "message recovery",
    );
    if (!response.ok) throw new OpenCodeHttpError(response.status, "message recovery");
    const page = record(body);
    const cursors = record(page?.cursor);
    if (!Array.isArray(page?.data) || !cursors || page.data.some((item: unknown) => typeof record(item)?.id !== "string")) {
      throw new OpenCodeProtocolError("OpenCode CLI v2 returned an invalid message page");
    }
    if (cursors.next !== undefined && cursors.next !== null && typeof cursors.next !== "string") throw new OpenCodeProtocolError("OpenCode CLI v2 returned an invalid message cursor");
    return { data: page.data as JsonRecord[], next: typeof cursors.next === "string" ? cursors.next : undefined };
  }

  private async messagesAfter(root: Root): Promise<JsonRecord[]> {
    const messages: JsonRecord[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.messagePage(cursor);
      if (this.root !== root || this.stopping) return [];
      for (const message of page.data) {
        if (message.id === root.baseline) return messages.reverse();
        messages.push(message);
      }
      if (!page.next) {
        if (root.baseline !== null) throw new OpenCodeProtocolError("OpenCode CLI v2 message recovery lost its root boundary");
        return messages.reverse();
      }
      if (cursors.has(page.next)) throw new OpenCodeProtocolError("OpenCode CLI v2 message cursor did not advance");
      cursors.add(page.next);
      cursor = page.next;
    }
  }

  private schedule(): void {
    if (!this.root || this.stopping || this.v2EvaluationTimer || this.v2Evaluating) return;
    this.v2EvaluationTimer = setTimeout(() => {
      this.v2EvaluationTimer = undefined;
      void this.evaluate();
    }, this.options.activePollMs ?? 100);
    this.v2EvaluationTimer.unref?.();
  }

  private async isActive(): Promise<boolean> {
    const { response, body } = await this.fetchJsonWithTimeout("/api/session/active", { method: "GET" }, "active session query");
    if (!response.ok) throw new OpenCodeHttpError(response.status, "active session query");
    const active = record(record(body)?.data);
    if (!active) throw new OpenCodeProtocolError("OpenCode CLI v2 returned invalid active session data");
    return active[this.sessionId!] !== undefined;
  }

  private async evaluate(): Promise<void> {
    const root = this.root;
    const identity = this.identity;
    if (!root || !identity || this.stopping || root.pending > 0 || root.inputs.size === 0 || this.v2Evaluating) return;
    this.v2Evaluating = true;
    const generation = root.generation;
    const current = () => this.root === root && root.generation === generation && root.pending === 0 && this.isIdentity(identity);
    try {
      if (await this.isActive()) return;
      if (!current()) return;
      const messages = await this.messagesAfter(root);
      if (!current()) return;
      let lastInput = -1;
      const delivered = new Set<string>();
      for (const [index, message] of messages.entries()) {
        if (message.type === "user" && typeof message.id === "string" && root.inputs.has(message.id)) {
          delivered.add(message.id);
          lastInput = index;
        }
      }
      const idle = messages.slice(lastInput + 1).reverse().find((message) => message.type === "idle");
      if (delivered.size !== root.inputs.size) {
        const { response, body } = await this.fetchJsonWithTimeout(
          `/api/session/${encodeURIComponent(this.sessionId!)}/inbox`, { method: "GET" }, "pending input recovery",
        );
        if (!response.ok) throw new OpenCodeHttpError(response.status, "pending input recovery");
        const pending = record(body)?.data;
        if (!Array.isArray(pending)) throw new OpenCodeProtocolError("OpenCode CLI v2 returned invalid inbox data");
        if (!current()) return;
        const retained = new Set(pending.map((item: unknown) => record(item)?.id));
        for (const id of root.inputs) {
          if (delivered.has(id) || retained.has(id)) continue;
          const recovered = await this.fetchJsonWithTimeout(
            `/api/session/${encodeURIComponent(this.sessionId!)}/message/${encodeURIComponent(id)}`,
            { method: "GET" }, "accepted input recovery",
          );
          if (!current()) return;
          if (recovered.response.status === 404) throw new OpenCodeProtocolError("OpenCode CLI v2 lost an accepted input from both inbox and messages");
          if (!recovered.response.ok) throw new OpenCodeHttpError(recovered.response.status, "accepted input recovery");
          const message = record(record(recovered.body)?.data);
          if (message?.id !== id || message.type !== "user") throw new OpenCodeProtocolError("OpenCode CLI v2 returned an invalid recovered input");
        }
        return;
      }
      for (const message of messages) { this.projectTools(message); this.projectMessage(message); }
      if (!idle || await this.isActive() || !current()) return;
      if (!["succeeded", "failed", "interrupted"].includes(String(idle.outcome))) {
        throw new OpenCodeProtocolError("OpenCode CLI v2 returned an invalid idle outcome");
      }
      this.root = null;
      if (idle.outcome === "failed") {
        const error = record(idle.error);
        this.events.emit("runtime_event", {
          kind: "error", code: "opencode.turn_failed",
          message: typeof error?.message === "string" ? error.message : "OpenCode CLI v2 execution failed",
        } satisfies AdapterEvent);
      }
      this.events.emit("runtime_event", {
        kind: "turn_end", sessionId: this.sessionId!, turnOwner: root.receipt,
      } satisfies AdapterEvent);
    } catch (error) {
      if (!current() || this.stopping) return;
      if (error instanceof OpenCodeProtocolError || (error instanceof OpenCodeHttpError && error.status < 500)) {
        this.protocolFailure("OpenCode CLI v2 durable message recovery failed", error);
      } else this.diagnostic("warning", "OpenCode CLI v2 message recovery temporarily unavailable; keeping the root active");
    } finally { this.v2Evaluating = false; this.schedule(); }
  }

  private toolKey(messageId: unknown, id: unknown): string | undefined {
    return typeof messageId === "string" && typeof id === "string" ? `${messageId}:${id}` : undefined;
  }

  private projectTool(data: JsonRecord): void {
    const key = this.toolKey(data.assistantMessageID, data.id);
    if (!key || this.settledTools.has(key)) return;
    const tool = this.liveTools.get(key) ?? { name: typeof data.name === "string" ? data.name : "OpenCode tool", called: false };
    if (tool.called) return;
    tool.called = true;
    this.liveTools.set(key, tool);
    this.events.emit("runtime_event", { kind: "tool_call", callId: key, name: tool.name, input: data.input } satisfies AdapterEvent);
  }

  private finishTool(key: string | undefined): void {
    if (!key || this.settledTools.has(key)) return;
    const tool = this.liveTools.get(key);
    if (!tool?.called) return;
    this.liveTools.delete(key);
    this.settledTools.add(key);
    this.events.emit("runtime_event", { kind: "tool_output", callId: key, name: tool.name } satisfies AdapterEvent);
  }

  private projectTools(message: JsonRecord): void {
    if (message.type !== "assistant" || !Array.isArray(message.content) || !this.root || this.stopping) return;
    for (const value of message.content) {
      const tool = record(value);
      const state = record(tool?.state);
      if (tool?.type !== "tool" || !["running", "completed", "error"].includes(String(state?.status))) continue;
      this.projectTool({ assistantMessageID: message.id, id: tool.id, name: tool.name, input: state?.input });
      if (state?.status !== "running") this.finishTool(this.toolKey(message.id, tool.id));
    }
  }

  private projectMessage(message: JsonRecord): void {
    if (message.type !== "assistant" || typeof message.id !== "string" || this.projectedMessages.has(message.id)) return;
    const time = record(message.time);
    if (time?.completed === undefined) return;
    this.projectedMessages.add(message.id);
    if (Array.isArray(message.content)) for (const value of message.content) {
      const content = record(value);
      if (typeof content?.text !== "string" || !content.text) continue;
      if (content.type === "text") this.events.emit("runtime_event", { kind: "assistant_message_completed", text: content.text } satisfies AdapterEvent);
      if (content.type === "reasoning") this.events.emit("runtime_event", { kind: "assistant_reasoning_completed", text: content.text } satisfies AdapterEvent);
    }
    const tokens = record(message.tokens);
    if (!tokens || !this.sessionId) return;
    const cache = record(tokens.cache);
    const identity = { runtime: "opencode", backendSessionId: this.sessionId, providerRecordId: message.id } as const;
    const usage = this.usage.project({
      ...identity, source: "opencode.v2", input: tokens.input, output: tokens.output, reasoning: tokens.reasoning,
      cacheRead: cache?.read, cacheWrite: cache?.write, inputIncludesCache: false, outputIncludesReasoning: false,
    });
    if (usage) this.events.emit("runtime_event", usage);
    this.usage.release(identity);
  }

  override async interrupt(_input: LaneInterruptInput): Promise<boolean> {
    const root = this.root;
    if (!root || !this.ready || this.stopping || !this.identityMatches()) return false;
    root.generation += 1;
    root.pending += 1;
    try {
      await this.requestNoContent(`/api/session/${encodeURIComponent(this.sessionId!)}/interrupt?resume=false`, "POST", undefined, "session interrupt");
      return true;
    } catch (error) {
      if (!this.stopping) void this.stop({ reason: "interrupt_timeout", forceAfterMs: 0 });
      throw error;
    } finally { root.pending -= 1; this.schedule(); }
  }

  override stop(input: LaneStopInput = {}): Promise<void> {
    this.root = null;
    if (this.v2EvaluationTimer) clearTimeout(this.v2EvaluationTimer);
    return super.stop(input);
  }
}
