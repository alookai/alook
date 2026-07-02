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
  /**
   * Backoff schedule. `authFailStreakThreshold` treats N consecutive HTTP-401
   * upgrade failures as an implicit `AUTH_REJECTED` — used when the server
   * has revoked the credential while the daemon was disconnected (so no
   * frame can reach the daemon over a socket that never opens). Defaults
   * to 3.
   */
  reconnect?: {
    baseMs?: number;
    maxMs?: number;
    maxAttempts?: number;
    authFailStreakThreshold?: number;
  };
  /** Heartbeat: ping every `pingIntervalMs`, declare dead after `pongTimeoutMs`. */
  heartbeat?: { pingIntervalMs?: number; pongTimeoutMs?: number };
  /** Called when the server explicitly rejects our machine key — no reconnect will follow. */
  onAuthRejected?: () => void;
  now?: () => number;
}

/** Outbound (host → server) control frames. */
type OutboundFrame =
  | { type: "ready"; ready: HostReady }
  | { type: "agent_session"; agentId: AgentId; sessionId: string; launchId: string }
  | { type: "agent_deliver_ack"; agentId: AgentId; deliveryId: string };

type ResyncProvider = () => { ready: HostReady; sessions: AgentSessionReport[] };

export class WsControlChannel implements HostControlChannel {
  private statusValue: ControlChannelStatus = "idle";
  private commandCb: ((cmd: HostCommand) => void | Promise<void>) | null = null;
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private closedByUser = false;
  private authRejected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline = 0;
  private resyncProvider: ResyncProvider | null = null;
  /**
   * Consecutive HTTP-401 upgrade failures. Reset by any `open` event. When
   * the count reaches `reconnect.authFailStreakThreshold`, we treat it as
   * an implicit `AUTH_REJECTED` — the server revoked our credential while
   * we were disconnected, so retrying is pointless.
   */
  private authFailStreak = 0;
  /**
   * HTTP status observed on the currently-connecting socket via the
   * `unexpected-response` event, if any. Consumed and cleared inside
   * `onSocketClosed`.
   */
  private lastUpgradeStatus: number | null = null;
  /** True once the socket emitted `open`. Reset on each `openSocket`. */
  private sawOpen = false;
  /**
   * Acks enqueued before the socket is open. Acks (not ready/session) are the
   * only frames worth buffering across a brief gap — ready/session are instead
   * regenerated fresh by the resync provider on (re)connect, so stale snapshots
   * are never replayed.
   */
  private pendingAcks: Array<{ agentId: AgentId; deliveryId: string }> = [];

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

  onCommand(cb: (cmd: HostCommand) => void | Promise<void>): void {
    this.commandCb = cb;
  }

  onResync(provider: ResyncProvider): void {
    this.resyncProvider = provider;
  }

  async reportReady(ready: HostReady): Promise<void> {
    this.sendFrame({ type: "ready", ready });
  }

  async reportAgentSession(info: { agentId: AgentId; sessionId: string; launchId: string }): Promise<void> {
    this.sendFrame({ type: "agent_session", ...info });
  }

  async reportDeliverAck(info: { agentId: AgentId; deliveryId: string }): Promise<void> {
    // Acks must not be lost across a brief disconnect — buffer if not open.
    if (this.statusValue !== "open" || !this.ws) {
      this.pendingAcks.push(info);
      return;
    }
    this.ws.send(JSON.stringify({ type: "agent_deliver_ack", ...info }));
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
      this.sendFrame({ type: "ready", ready });
      for (const s of sessions) this.sendFrame({ type: "agent_session", ...s });
    }
    if (this.pendingAcks.length && this.ws && this.statusValue === "open") {
      const acks = this.pendingAcks;
      this.pendingAcks = [];
      for (const a of acks) this.ws.send(JSON.stringify({ type: "agent_deliver_ack", ...a }));
    }
  }

  private openSocket(): void {
    this.statusValue = this.attempt === 0 ? "connecting" : "reconnecting";
    this.sawOpen = false;
    this.lastUpgradeStatus = null;
    const ws = this.opts.webSocketFactory(this.opts.url, this.opts.headers ?? {});
    this.ws = ws;

    ws.on("open", () => {
      this.sawOpen = true;
      this.authFailStreak = 0;
      this.statusValue = "open";
      this.startHeartbeat();
      this.resyncOnConnect();
    });
    ws.on("message", (data: unknown) => this.onMessage(data));
    ws.on("pong", () => {
      this.attempt = 0;
      this.pongDeadline = this.now() + (this.opts.heartbeat?.pongTimeoutMs ?? 30_000);
    });
    // The `ws` npm package fires `unexpected-response` when the HTTP upgrade
    // handshake returns a non-101 status. Capture the status so we can tell
    // 401-revoked-credential apart from network failures in `onSocketClosed`.
    ws.on("unexpected-response", (_req: unknown, res: unknown) => {
      const status = (res as { statusCode?: number })?.statusCode;
      if (typeof status === "number") {
        this.lastUpgradeStatus = status;
      }
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
    this.commandCb?.(frame as unknown as HostCommand);
  }

  private onSocketClosed(): void {
    this.clearHeartbeat();
    this.ws = null;
    if (this.closedByUser) return;
    if (this.authRejected) {
      this.statusValue = "closed";
      return;
    }
    // Detect "server revoked our credential while we were disconnected".
    // A 401 on the HTTP upgrade means the current cmk_ is no longer good.
    // After N in a row we treat it as if AUTH_REJECTED came over a frame.
    if (!this.sawOpen && this.lastUpgradeStatus === 401) {
      this.authFailStreak += 1;
      const threshold = this.opts.reconnect?.authFailStreakThreshold ?? 3;
      if (this.authFailStreak >= threshold) {
        this.authRejected = true;
        this.statusValue = "closed";
        this.opts.onAuthRejected?.();
        return;
      }
    }
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
