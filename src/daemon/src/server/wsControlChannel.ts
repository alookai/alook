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
import { createLogger, type Logger } from "../logger.js";
// Re-export so existing importers of these from this module keep working.
export type { WebSocketLike, WebSocketFactory } from "./contract.js";

export type ControlChannelStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

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
  | HostBotAuditEventFrame
  | SessionErrorFrame;

type ResyncProvider = () => { ready: HostReady; sessions: AgentSessionReport[] };

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class WsControlChannel implements HostControlChannel {
  private statusValue: ControlChannelStatus = "idle";
  // Multiple listeners so consumers can layer behavior (e.g. bot-cache pre-hook
  // + AgentRouter's real handler) without monkey-patching this class.
  private commandCbs: Array<(cmd: HostCommand) => void | Promise<void>> = [];
  private resyncHooks: Array<() => void> = [];
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private closedByUser = false;
  private authRejected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline = 0;
  private resyncProvider: ResyncProvider | null = null;
  private readonly log: Logger;

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
  onCommand(cb: (cmd: HostCommand) => void | Promise<void>): void {
    this.commandCbs.push(cb);
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
    this.sendFrame({ type: "agent_activity", ...info });
  }

  /**
   * Emit a bot audit event upward — either from the credential proxy sighting
   * (`cli_invocation`) or from a runtime `thinking` / non-Bash `tool_call`
   * event. Frame is dropped when the socket isn't open; audit events are
   * point-in-time (not resynced on reconnect), matching the ready/session
   * policy above.
   */
  async reportBotAuditEvent(frame: HostBotAuditEventFrame): Promise<void> {
    this.sendFrame(frame);
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
      const { ready, sessions } = this.resyncProvider();
      this.sendFrame({ type: "ready", ...ready });
      for (const s of sessions) this.sendFrame({ type: "agent_session", ...s });
      this.log.info("resync sent", { ready: ready.runtimeReport.length, sessions: sessions.length });
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
      this.pongDeadline = this.now() + (this.opts.heartbeat?.pongTimeoutMs ?? 30_000);
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

    // Valid server frame — reset backoff (server accepted us).
    this.attempt = 0;
    const cmd = frame as unknown as HostCommand;
    for (const cb of this.commandCbs) {
      // Each listener is fire-and-forget; failures in one must not skip the
      // next. Catch rejections explicitly — a bare `void cb(cmd)` on an async
      // listener that throws would surface as an unhandled promise rejection
      // and, under Node ≥15 defaults, could terminate the daemon.
      try {
        Promise.resolve(cb(cmd)).catch((err: unknown) => {
          this.log.warn("command listener threw", { type: cmd.type, err: describeErr(err) });
        });
      } catch (err) {
        this.log.warn("command listener threw synchronously", { type: cmd.type, err: describeErr(err) });
      }
    }
  }

  private onSocketClosed(code?: number, reason?: unknown): void {
    this.log.warn("control channel closed", { code, reason: reason ? String(reason) : "" });
    this.clearHeartbeat();
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
    const base = this.opts.reconnect?.baseMs ?? 500;
    const max = this.opts.reconnect?.maxMs ?? 30_000;
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
    const interval = this.opts.heartbeat?.pingIntervalMs ?? 15_000;
    const timeout = this.opts.heartbeat?.pongTimeoutMs ?? 30_000;
    this.pongDeadline = this.now() + timeout;
    this.pingTimer = setInterval(() => {
      if (this.now() > this.pongDeadline) {
        // Watchdog: no pong in time → treat as dead, force reconnect.
        this.log.warn("heartbeat pong timeout — forcing reconnect");
        this.ws?.close();
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

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
