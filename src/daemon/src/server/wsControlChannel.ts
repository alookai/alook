/**
 * WsControlChannel — a real-server `HostControlChannel` over a WebSocket.
 *
 * This is the network counterpart to `LocalControlChannel`: where the local one
 * bridges an in-process `MockServer`, this one carries the same control-plane
 * frames (`HostCommand` down, `HostReady` / agent-session reports up) over a
 * WebSocket, with **exponential-backoff reconnect** and a **heartbeat watchdog**.
 *
 * The socket is injected (`WebSocketFactory`) so this file stays dependency-free
 * and testable; a deployment passes a factory built on the `ws` package. The
 * endpoint URL and auth headers are host-supplied — no platform is hardcoded.
 *
 * Wire framing is intentionally minimal and host-defined:
 *   - inbound frames are JSON `HostCommand`-shaped (server → host);
 *   - outbound frames are JSON `{ type: "ready" | "agent_session", … }` (host → server).
 * A real server adapter maps these to its own protocol.
 *
 * This is the control plane local dev actually uses: `mock-server`+`daemon` and the
 * `control-plane-e2e` example run the server (`WsControlServer`) and host
 * (`WsControlChannel`) over a real loopback WebSocket, so the transport —
 * reconnect/heartbeat and frame (de)serialization — is exercised end to end
 * rather than shortcut in-process. `LocalControlChannel` remains only for pure
 * unit tests that don't need a socket.
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
} from "./contract.js";
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
 * `agent_started_ack` / `agent_stopped_ack` are new frames. `agent_deliver_ack`
 * is additively extended with optional `status` + `error`; existing server-side
 * consumers that read only `{ agentId, deliveryId }` still work.
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
  | {
      type: "agent_deliver_ack";
      agentId: AgentId;
      deliveryId: string;
      status?: AgentCommandAckStatus;
      error?: AgentCommandAckError;
    }
  | {
      type: "agent_started_ack";
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
  | SessionErrorFrame;

type ResyncProvider = () => { ready: HostReady; sessions: AgentSessionReport[] };

type PendingAck = {
  agentId: AgentId;
  deliveryId: string;
  status?: AgentCommandAckStatus;
  error?: AgentCommandAckError;
};

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
  /**
   * Acks enqueued before the socket is open. Acks (not ready/session) are the
   * only frames worth buffering across a brief gap — ready/session are instead
   * regenerated fresh by the resync provider on (re)connect, so stale snapshots
   * are never replayed.
   */
  private pendingAcks: PendingAck[] = [];

  constructor(private readonly opts: WsControlChannelOpts) {}

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

  async reportDeliverAck(info: {
    agentId: AgentId;
    deliveryId: string;
    status?: AgentCommandAckStatus;
    error?: AgentCommandAckError;
  }): Promise<void> {
    // Acks must not be lost across a brief disconnect — buffer if not open.
    if (this.statusValue !== "open" || !this.ws) {
      this.pendingAcks.push(info);
      return;
    }
    this.ws.send(JSON.stringify({ type: "agent_deliver_ack", ...info }));
  }

  /** Reply to an `agent:start` HostCommand with the launch outcome. */
  async reportStartedAck(info: {
    agentId: AgentId;
    launchId: string;
    status: AgentCommandAckStatus;
    error?: AgentCommandAckError;
  }): Promise<void> {
    this.sendFrame({ type: "agent_started_ack", ...info });
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
    if (this.statusValue !== "open" || !this.ws) return;
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * On every (re)connect, re-announce the host's CURRENT state: ready handshake
   * + a fresh agent_session per live agent (from the resync provider), then flush
   * any buffered acks. This is what lets the server recover this host after a
   * dropped connection.
   */
  private resyncOnConnect(): void {
    if (this.resyncProvider) {
      const { ready, sessions } = this.resyncProvider();
      this.sendFrame({ type: "ready", ...ready });
      for (const s of sessions) this.sendFrame({ type: "agent_session", ...s });
    }
    if (this.pendingAcks.length && this.ws && this.statusValue === "open") {
      const acks = this.pendingAcks;
      this.pendingAcks = [];
      for (const a of acks) this.ws.send(JSON.stringify({ type: "agent_deliver_ack", ...a }));
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
      this.startHeartbeat();
      this.resyncOnConnect();
    });
    ws.on("message", (data: unknown) => this.onMessage(data));
    ws.on("pong", () => {
      this.attempt = 0;
      this.pongDeadline = this.now() + (this.opts.heartbeat?.pongTimeoutMs ?? 30_000);
    });
    ws.on("close", () => this.onSocketClosed());
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
        Promise.resolve(cb(cmd)).catch(() => {
          /* listener failure — swallowed, transport keeps going */
        });
      } catch {
        /* sync throw from a listener — same policy */
      }
    }
  }

  private onSocketClosed(): void {
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
        this.ws?.close();
        return;
      }
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
