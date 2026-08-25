/**
 * WsControlChannel — a real-server `HostControlChannel` over a WebSocket.
 *
 * This is the host end of the control plane: it carries `HostCommand` frames
 * down (`agent:wake` / `agent:stop` / `bot:*`) and `HostReady` / agent-session
 * reports up, over a WebSocket, with **exponential-backoff reconnect** and a
 * **heartbeat watchdog**.
 *
 * The socket is injected (`WebSocketFactory`) so this file stays dependency-free
 * and testable; a deployment passes a factory built on the `ws` package. The
 * endpoint URL and auth headers are host-supplied — no platform is hardcoded.
 *
 * Wire framing is intentionally minimal and host-defined:
 *   - inbound frames are JSON `HostCommand`-shaped (server → host), now just
 *     `agent:wake` / `agent:stop` / `bot:*` (minimal-wake-queue-unread-notice
 *     plan §2 — `agent:start`/`agent:deliver` are gone);
 *   - outbound frames are JSON `{ type: "ready" | "agent_session" | "agent_wake_ack" | "agent_stopped_ack", … }` (host → server).
 * A real server adapter maps these to its own protocol.
 *
 * `tests/integration/daemon/control-plane.test.ts` exercises this class over
 * a real WebSocket against a real `ws-do` dev server — the transport
 * (reconnect/heartbeat and frame (de)serialization) end to end, rather than
 * shortcut in-process.
 */
import { BotAuditEventAckFrameSchema } from "@alook/shared";
import type {
  HostControlChannel,
  HostCommand,
  HostReady,
  AgentId,
  AgentSessionReport,
  SessionErrorFrame,
  WebSocketLike,
  WebSocketFactory,
  AgentActivityState,
  HostBotAuditEventFrame,
} from "./contract.js";
import { HostCommandSchema } from "./contract.js";
import { createLogger, type Logger } from "../logger.js";
import { WakeCoordinator } from "../manager/wakeCoordinator.js";
// Re-export so existing importers of these from this module keep working.
export type { WebSocketLike, WebSocketFactory } from "./contract.js";

export type ControlChannelStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * A synchronous, channel-owned dispatch result used by a pre-router consumer
 * to claim one command. Promises never consume: the decision must be visible
 * before the dispatcher advances to the next FIFO listener.
 */
export const WS_CONTROL_COMMAND_CONSUMED = Symbol("ws-control-command-consumed");
type CommandListener = (
  cmd: HostCommand,
) => void | Promise<void> | typeof WS_CONTROL_COMMAND_CONSUMED;
type WakeDesiredListener = (cmd: Extract<HostCommand, { type: "agent:wake" }>) => void;

/** Heartbeat: how often we ping the server WebSocket. */
const DEFAULT_PING_INTERVAL_MS = 15_000;
/** Heartbeat: how long we wait for a pong before declaring the socket dead. */
const DEFAULT_PONG_TIMEOUT_MS = 30_000;
/** Reconnect: initial backoff after a drop, doubling each attempt up to the max. */
const DEFAULT_RECONNECT_BASE_MS = 500;
/** Reconnect: ceiling on the exponential backoff. */
const DEFAULT_RECONNECT_MAX_MS = 30_000;
/** Reliable audit receipt timeout; retried forever with this bounded cadence. */
const DEFAULT_AUDIT_ACK_RETRY_MS = 5_000;

export interface WsControlChannelOpts {
  url: string;
  /** Auth headers (e.g. Authorization, X-Agent-Id) — host-supplied. */
  headers?: Record<string, string>;
  webSocketFactory: WebSocketFactory;
  /** Exponential-backoff reconnect schedule. */
  reconnect?: {
    baseMs?: number;
    maxMs?: number;
    maxAttempts?: number;
  };
  /** Heartbeat: ping every `pingIntervalMs`, declare dead after `pongTimeoutMs`. */
  heartbeat?: { pingIntervalMs?: number; pongTimeoutMs?: number };
  /** Receipt retry cadence for durable audit completions. */
  auditAckRetryMs?: number;
  /** Clears the matching local durable fact; false keeps retrying. */
  onBotAuditEventAck?: (info: { agentId: AgentId; eventId: string }) => boolean;
  /**
   * Called when the server explicitly rejects our machine key via an
   * `AUTH_REJECTED` frame — the SOLE terminal-revocation signal. HTTP 401s
   * on upgrade are treated as transient (network flake between us and CF
   * before D1 is reachable, for instance) and reconnect with backoff.
   */
  onAuthRejected?: () => void;
  now?: () => number;
  /** Defaults to `createLogger({ header: "@alook/daemon:ws" })`. */
  logger?: Logger;
}

/**
 * Outbound (host → server) control frames.
 *
 * `ready` is spread FLAT into the frame (not nested under a `ready` key) so
 * the shape matches `HostReadyMessageSchema` in @alook/shared — the server
 * (community DO) validates frames against that schema, so any nesting drop
 * would silently be discarded.
 */
/**
 * Command reply protocol — daemon → server. New in v0.2.0.
 *
 * `agent_wake_ack` means "daemon accepted/handled the `agent:wake` command,"
 * NOT "process started" — a wake may spawn, notify an already-running
 * process, or coalesce for later (see `HostControlChannel.reportWakeAck`).
 * `agent_deliver_ack` / `reportDeliverAck` are retired together with
 * `agent:deliver` — the server never decides start-vs-deliver, so there is
 * nothing left for the daemon to ack beyond the wake command itself.
 *
 * Error codes:
 *   - bot_unknown       daemon received a command for a bot not in botsById
 *   - bot_enroll_failed enrollAgent call failed (server 5xx / network)
 *   - bot_runtime_missing bot's runtime not in live availableRuntimes
 *   - bot_not_a_member  bot not a communityServerMember of target channel
 *   - internal_error    catch-all
 */
export type AgentCommandAckStatus = "ok" | "error";
export type AgentCommandAckError = { code: string; message: string };

type OutboundFrame =
  | ({ type: "ready" } & HostReady)
  | { type: "agent_session"; agentId: AgentId; sessionId: string; launchId: string }
  | { type: "agent_activity"; agentId: AgentId; state: AgentActivityState }
  | { type: "agent_typing"; agentId: AgentId; channelId: string }
  | { type: "agent_typing_stop"; agentId: AgentId; channelId: string }
  | {
      type: "agent_wake_ack";
      agentId: AgentId;
      launchId: string;
      status: AgentCommandAckStatus;
      error?: AgentCommandAckError;
    }
  | {
      type: "agent_stopped_ack";
      agentId: AgentId;
      status: AgentCommandAckStatus;
      error?: AgentCommandAckError;
    }
  | { type: "machine_heartbeat_ack"; nonce: string }
  | { type: "diagnostics_ack"; reportId: string }
  | HostBotAuditEventFrame
  | SessionErrorFrame;

type AgentActivityReport = { agentId: AgentId; state: AgentActivityState };
type ResyncProvider = () => {
  ready: HostReady;
  sessions: AgentSessionReport[];
  activities?: AgentActivityReport[];
};

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class WsControlChannel implements HostControlChannel {
  private statusValue: ControlChannelStatus = "idle";
  // Multiple listeners so consumers can layer behavior (e.g. bot-cache pre-hook
  // + AgentRouter's real handler) without monkey-patching this class.
  private commandCbs: CommandListener[] = [];
  private wakeDesiredCbs: WakeDesiredListener[] = [];
  private resyncHooks: Array<() => void> = [];
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private closedByUser = false;
  private authRejected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private auditRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pongDeadline = 0;
  private resyncProvider: ResyncProvider | null = null;
  private readonly pendingBotAuditEvents = new Map<string, HostBotAuditEventFrame>();
  private readonly log: Logger;
  private readonly wakeCoordinator = new WakeCoordinator();

  constructor(private readonly opts: WsControlChannelOpts) {
    this.log = opts.logger ?? createLogger({ header: "@alook/daemon:ws" });
  }

  get status(): ControlChannelStatus {
    return this.statusValue;
  }

  /** Open the socket and begin consuming server→host commands. */
  connect(): void {
    this.closedByUser = false;
    this.authRejected = false;
    this.openSocket();
  }

  close(): void {
    this.closedByUser = true;
    this.clearHeartbeat();
    this.clearAuditRetry();
    this.ws?.close();
    this.ws = null;
    this.statusValue = "closed";
  }

  /* ---- HostControlChannel ---------------------------------------- */

  /**
   * Register a command listener. Multiple listeners may be registered; they
   * run in FIFO order on each inbound frame. This lets a pre-hook (bot cache)
   * observe frames before the AgentRouter's dispatcher without wrapping them.
   */
  onCommand(cb: CommandListener): void {
    this.commandCbs.push(cb);
  }

  /** Observe only wakes that advance an agent/channel desired watermark. */
  onWakeDesiredAdvance(cb: WakeDesiredListener): void {
    this.wakeDesiredCbs.push(cb);
  }

  /**
   * Inject a command through the same schema and semantic ingress as a WS
   * frame, so alternate control transports cannot bypass observers, routing,
   * lifecycle handling, or duplicate suppression.
   */
  async ingestCommand(frame: unknown): Promise<boolean> {
    const parsed = HostCommandSchema.safeParse(frame);
    if (!parsed.success) {
      this.log.warn("dropped malformed HostCommand frame", {
        type: typeof frame === "object" && frame !== null && "type" in frame
          ? String((frame as { type?: unknown }).type)
          : "unknown",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      });
      return false;
    }
    await this.dispatchIngressCommand(parsed.data as HostCommand);
    return true;
  }

  modelSeenGeneration(agentId: string): number {
    return this.wakeCoordinator.modelSeenGeneration(agentId);
  }

  recordModelSeen(
    agentId: string,
    messages: ReadonlyArray<{ channel: string; seq: string }>,
    generation = this.wakeCoordinator.modelSeenGeneration(agentId),
  ): boolean {
    return this.wakeCoordinator.recordModelSeen(agentId, messages, generation);
  }

  /**
   * The resync provider builds the current-state snapshot the server needs on
   * every (re)connect. Only one provider makes sense; the last registration
   * wins (matches prior single-provider semantics).
   */
  onResync(provider: ResyncProvider): void {
    this.resyncProvider = provider;
  }

  /**
   * Register a side-effect hook fired every time the channel opens and
   * completes its resync — including the FIRST open, not just reconnects. Used
   * e.g. for daemon warmup fetches. Independent of the resync provider so
   * warmup composes with the state-snapshot path.
   */
  onOpen(hook: () => void): void {
    this.resyncHooks.push(hook);
  }

  async reportReady(ready: HostReady): Promise<void> {
    this.sendFrame({ type: "ready", ...ready });
  }

  /**
   * On-demand ready-frame resend. Same envelope as `reportReady` — matches
   * `HostReadyMessageSchema` on the server side. Used by `AgentRouter` to
   * push updated runtime-health without waiting for a reconnect. When the
   * socket isn't open, `sendFrame` no-ops and the next `resyncOnConnect`
   * emits the live snapshot instead.
   *
   * Sync (not async): the caller — health-mutation coalescer — schedules
   * this on a microtask boundary and does not await it.
   */
  sendReady(ready: HostReady): void {
    this.sendFrame({ type: "ready", ...ready });
  }

  async reportAgentSession(info: { agentId: AgentId; sessionId: string; launchId: string }): Promise<void> {
    this.sendFrame({ type: "agent_session", ...info });
  }

  async reportAgentActivity(info: { agentId: AgentId; state: AgentActivityState }): Promise<void> {
    this.wakeCoordinator.recordAgentActivity(info.agentId, info.state);
    this.sendFrame({ type: "agent_activity", ...info });
  }

  /**
   * Emit an `agent_typing` frame (daemon → server). Sync + fire-and-forget:
   * this is a heartbeat, dropped silently when the socket isn't open — the
   * next heartbeat tick re-fires within 5s and the client's 8s expiry keeps
   * the pill from flickering. Never traverses the ws-do 8s dedup gate on
   * the client-inbound path (the daemon meters cadence, ws-do fans out
   * unconditionally).
   */
  reportAgentTyping(info: { agentId: AgentId; channelId: string }): void {
    this.sendFrame({ type: "agent_typing", ...info });
  }

  /**
   * Emit an `agent_typing_stop` frame (daemon → server). One-shot at turn
   * end; ws-do fans out `community:typing.stop` with no dedup so the pill
   * clears within ~50ms.
   */
  reportAgentTypingStop(info: { agentId: AgentId; channelId: string }): void {
    this.sendFrame({ type: "agent_typing_stop", ...info });
  }

  /**
   * Emit a bot audit event upward. Automatic idle-reset completions are
   * reliable: assign a stable id, retain before the first send, replay on
   * reconnect, and clear only after the server acknowledges its durable write.
   * Other audit events remain point-in-time and may drop while disconnected.
   */
  async reportBotAuditEvent(frame: HostBotAuditEventFrame): Promise<void> {
    if (
      frame.event.kind === "session_reset" &&
      frame.event.payload.trigger === "idle_timeout"
    ) {
      if (!frame.eventId || !frame.occurredAt) {
        this.log.error("durable idle-reset audit missing local receipt", {
          agentId: frame.agentId,
        });
        return;
      }
      this.pendingBotAuditEvents.set(frame.eventId, frame);
      this.sendFrame(frame);
      this.scheduleAuditRetry();
      return;
    }
    this.sendFrame(frame);
  }

  /** Restore one completion from the timeline's durable outbox after startup. */
  restorePendingBotAuditEvent(frame: HostBotAuditEventFrame): void {
    if (!frame.eventId || !frame.occurredAt) return;
    this.pendingBotAuditEvents.set(frame.eventId, frame);
    this.sendFrame(frame);
    this.scheduleAuditRetry();
  }

  /**
   * Reply to an `agent:wake` HostCommand with the wake outcome — "daemon
   * accepted/handled the wake command", NOT "process started" (see
   * `HostControlChannel.reportWakeAck`).
   */
  async reportWakeAck(info: {
    agentId: AgentId;
    launchId: string;
    status: AgentCommandAckStatus;
    error?: AgentCommandAckError;
  }): Promise<void> {
    this.wakeCoordinator.recordDeliveryAck(info.agentId, info.launchId, info.status);
    this.sendFrame({ type: "agent_wake_ack", ...info });
  }

  /** Reply to an `agent:stop` HostCommand with the stop outcome. */
  async reportStoppedAck(info: {
    agentId: AgentId;
    status: AgentCommandAckStatus;
    error?: AgentCommandAckError;
  }): Promise<void> {
    this.sendFrame({ type: "agent_stopped_ack", ...info });
  }

  async reportSessionError(frame: SessionErrorFrame): Promise<void> {
    // `session.error` is a point-in-time report; dropping if not open matches
    // the ready/agent_session policy — the server won't have addressed the
    // launch anyway, so the daemon just no-ops until reconnect.
    this.sendFrame(frame);
  }

  /* ---- transport ------------------------------------------------- */

  private sendFrame(frame: OutboundFrame): void {
    // ready/agent_session are point-in-time state; if the socket isn't open we
    // drop them here and let the resync provider regenerate fresh state on the
    // next (re)connect — never replay a stale snapshot.
    if (this.statusValue !== "open" || !this.ws) {
      this.log.debug("frame dropped — socket not open", { type: frame.type });
      return;
    }
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * On every (re)connect, re-announce the host's CURRENT state: ready handshake
   * + a fresh agent_session per live agent (from the resync provider). This is
   * what lets the server recover this host after a dropped connection.
   */
  private resyncOnConnect(): void {
    if (this.resyncProvider) {
      const { ready, sessions, activities } = this.resyncProvider();
      this.sendFrame({ type: "ready", ...ready });
      for (const s of sessions) this.sendFrame({ type: "agent_session", ...s });
      // Re-assert each live agent's current activity: `agent_activity` is
      // edge-triggered, so a frame dropped during the disconnect window is
      // otherwise lost forever, stranding the pill on a stale state.
      const liveActivities = activities ?? [];
      for (const a of liveActivities) this.sendFrame({ type: "agent_activity", ...a });
      for (const frame of this.pendingBotAuditEvents.values()) this.sendFrame(frame);
      this.scheduleAuditRetry();
      this.log.info("resync sent", {
        ready: ready.runtimeReport.length,
        sessions: sessions.length,
        activities: liveActivities.length,
        pendingAuditEvents: this.pendingBotAuditEvents.size,
      });
    }
    for (const hook of this.resyncHooks) {
      try {
        hook();
      } catch {
        // Hooks are fire-and-forget; a hook failure must not block resync.
      }
    }
  }

  private openSocket(): void {
    this.statusValue = this.attempt === 0 ? "connecting" : "reconnecting";
    const ws = this.opts.webSocketFactory(this.opts.url, this.opts.headers ?? {});
    this.ws = ws;

    ws.on("open", () => {
      this.statusValue = "open";
      this.log.info("control channel open", { attempt: this.attempt });
      this.startHeartbeat();
      this.resyncOnConnect();
    });
    ws.on("message", (data: unknown) => this.onMessage(data));
    ws.on("pong", () => {
      this.attempt = 0;
      this.pongDeadline = this.now() + (this.opts.heartbeat?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS);
      this.log.debug("heartbeat pong");
    });
    ws.on("close", (code?: number, reason?: unknown) => this.onSocketClosed(code, reason));
    // Errors surface via the socket's own close; a host factory may also log.
    ws.on("error", () => {
      /* swallow — close handler drives reconnect */
    });
  }

  private onMessage(data: unknown): void {
    let frame: Record<string, unknown> | null = null;
    try {
      frame = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    if (frame.type === "error" && frame.code === "AUTH_REJECTED") {
      this.authRejected = true;
      this.log.error("AUTH_REJECTED received — machine key rejected, not reconnecting");
      this.opts.onAuthRejected?.();
      return;
    }

    const auditAck = BotAuditEventAckFrameSchema.safeParse(frame);
    if (auditAck.success) {
      this.attempt = 0;
      const pending = this.pendingBotAuditEvents.get(auditAck.data.eventId);
      if (!pending) return;
      let durableCleared = this.opts.onBotAuditEventAck === undefined;
      try {
        durableCleared = this.opts.onBotAuditEventAck?.({
          agentId: pending.agentId,
          eventId: auditAck.data.eventId,
        }) ?? true;
      } catch (err) {
        this.log.warn("bot audit ack local clear threw", {
          eventId: auditAck.data.eventId,
          err: describeErr(err),
        });
      }
      if (durableCleared) this.pendingBotAuditEvents.delete(auditAck.data.eventId);
      else this.log.warn("bot audit ack local clear deferred", { eventId: auditAck.data.eventId });
      if (this.pendingBotAuditEvents.size === 0) this.clearAuditRetry();
      else this.scheduleAuditRetry();
      return;
    }

    // Valid server frame — reset backoff (server accepted us). AUTH_REJECTED
    // (above) is an `error` frame, NOT a HostCommand, so it stays ahead of the
    // schema gate and short-circuits regardless of command validity.
    this.attempt = 0;

    void this.ingestCommand(frame).catch((err: unknown) => {
      this.log.warn("command ingress failed", { type: frame.type, err: describeErr(err) });
    });
  }

  private async dispatchListeners(cmd: HostCommand): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const cb of this.commandCbs) {
      // Each listener is fire-and-forget; failures in one must not skip the
      // next. Catch rejections explicitly — a bare `void cb(cmd)` on an async
      // listener that throws would surface as an unhandled promise rejection
      // and, under Node ≥15 defaults, could terminate the daemon.
      try {
        const result = cb(cmd);
        if (result === WS_CONTROL_COMMAND_CONSUMED) break;
        pending.push(Promise.resolve(result).catch((err: unknown) => {
          this.log.warn("command listener threw", { type: cmd.type, err: describeErr(err) });
        }));
      } catch (err) {
        this.log.warn("command listener threw synchronously", { type: cmd.type, err: describeErr(err) });
      }
    }
    await Promise.all(pending);
  }

  private async dispatchIngressCommand(cmd: HostCommand): Promise<void> {
    if (cmd.type === "machine:heartbeat") {
      this.sendFrame({ type: "machine_heartbeat_ack", nonce: cmd.nonce });
      return;
    }
    if (cmd.type === "diagnostics:collect") {
      // Receipt means only that the daemon websocket ingress parsed this frame.
      // Collection acceptance/completion remains authoritative in the durable
      // diagnostic-report row and must never be inferred from this ack.
      this.sendFrame({ type: "diagnostics_ack", reportId: cmd.reportId });
      await this.dispatchListeners(cmd);
      return;
    }
    if (cmd.type === "agent:wake") {
      const result = await this.wakeCoordinator.run(cmd, (accepted) =>
        this.dispatchListeners(accepted), (advanced) => {
          for (const cb of this.wakeDesiredCbs) {
            try {
              cb(advanced);
            } catch (err) {
              this.log.warn("wake desired observer threw", { err: describeErr(err) });
            }
          }
        });
      if (result.state === "suppressed") {
        await this.reportWakeAck({
          agentId: cmd.agentId,
          launchId: cmd.launchId,
          status: "ok",
        });
        this.log.debug("duplicate wake suppressed", {
          agentId: cmd.agentId,
          channel: cmd.unreadNotice.channel,
          latestSeq: cmd.unreadNotice.latestSeq,
          coveredSeq: result.coveredSeq,
        });
      }
      return;
    }

    if (cmd.type === "machine:reset_all") {
      for (const reset of cmd.resets) this.wakeCoordinator.invalidate(reset.agentId, true);
      await this.dispatchListeners(cmd);
      return;
    }
    if (cmd.type === "agent:stop" || cmd.type === "agent:model_switch") {
      this.wakeCoordinator.invalidate(cmd.agentId, false);
    } else if (cmd.type === "agent:reset" || cmd.type === "agent:nap") {
      this.wakeCoordinator.invalidate(cmd.agentId, true);
    } else if (cmd.type === "bot:removed") {
      this.wakeCoordinator.invalidate(cmd.botId, true);
    }
    await this.dispatchListeners(cmd);
  }

  private onSocketClosed(code?: number, reason?: unknown): void {
    this.log.warn("control channel closed", { code, reason: reason ? String(reason) : "" });
    this.clearHeartbeat();
    this.clearAuditRetry();
    this.ws = null;
    if (this.closedByUser) return;
    if (this.authRejected) {
      this.statusValue = "closed";
      return;
    }
    // HTTP 401 on upgrade → transient. Only an inbound `AUTH_REJECTED` frame
    // (see onMessage) sets `authRejected`; anything else keeps retrying with
    // exponential backoff so daemons behind flaky edges survive.
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const base = this.opts.reconnect?.baseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const max = this.opts.reconnect?.maxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const maxAttempts = this.opts.reconnect?.maxAttempts ?? Infinity;
    if (this.attempt >= maxAttempts) {
      this.statusValue = "closed";
      return;
    }
    this.attempt += 1;
    const delayMs = Math.min(max, base * 2 ** (this.attempt - 1));
    this.statusValue = "reconnecting";
    this.log.info("reconnecting", { attempt: this.attempt, delayMs });
    // NOTE: do NOT `t.unref()` — this timer is what keeps the daemon alive
    // while it's waiting to reconnect. Unrefing it here caused the daemon
    // to silently exit(0) when the server dropped the socket (no other
    // refed handles once the WS handle was gone).
    setTimeout(() => this.openSocket(), delayMs);
  }

  private startHeartbeat(): void {
    const interval = this.opts.heartbeat?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const timeout = this.opts.heartbeat?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.pongDeadline = this.now() + timeout;
    this.pingTimer = setInterval(() => {
      if (this.now() > this.pongDeadline) {
        // Watchdog: no pong in time → treat as dead, force reconnect.
        this.log.warn("heartbeat pong timeout — forcing reconnect");
        if (this.ws?.terminate) this.ws.terminate();
        else this.ws?.close();
        return;
      }
      this.log.debug("heartbeat ping");
      this.ws?.ping?.();
    }, interval);
    this.pingTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleAuditRetry(): void {
    if (this.auditRetryTimer || this.pendingBotAuditEvents.size === 0) return;
    const delayMs = this.opts.auditAckRetryMs ?? DEFAULT_AUDIT_ACK_RETRY_MS;
    this.auditRetryTimer = setTimeout(() => {
      this.auditRetryTimer = null;
      if (this.statusValue === "open") {
        for (const frame of this.pendingBotAuditEvents.values()) this.sendFrame(frame);
      }
      this.scheduleAuditRetry();
    }, delayMs);
    this.auditRetryTimer.unref?.();
  }

  private clearAuditRetry(): void {
    if (!this.auditRetryTimer) return;
    clearTimeout(this.auditRetryTimer);
    this.auditRetryTimer = null;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
