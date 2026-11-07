
import type { HostCommand, HostReady, AgentId, WebSocketLike } from "./contract.js";

export type { WebSocketLike } from "./contract.js";

export interface WsConnectionMeta {
  /** The `Authorization` header on the upgrade request (e.g. `Bearer <machineKey>`). */
  authHeader?: string;
}

/**
 * The subset of a ws *server* this module uses (matches `ws`'s WebSocketServer).
 * The `connection` callback's second arg carries the upgrade request's auth
 * header so the control plane can authenticate the connecting daemon — the
 * factory adapter (in a deployment/test harness) pulls it off the `ws` upgrade
 * request.
 */
export interface WebSocketServerLike {
  on(event: "connection", cb: (socket: WebSocketLike, meta?: WsConnectionMeta) => void): void;
  close(cb?: () => void): void;
}

type AckStatus = "ok" | "error";
type AckError = { code: string; message: string };

/** Inbound (host → server) control frames. `ready` fields are spread flat — see `WsControlChannel`. */
type InboundFrame =
  | ({ type: "ready" } & HostReady)
  | { type: "agent_session"; agentId: AgentId; sessionId: string; launchId: string }
  | { type: "agent_wake_ack"; agentId: AgentId; launchId: string; status: AckStatus; error?: AckError }
  | { type: "agent_stopped_ack"; agentId: AgentId; launchId?: string; status: AckStatus; error?: AckError };

export interface WsControlServerOpts {
  /**
   * Build the ws server bound to `port` on loopback. Injected so this module has
   * no hard `ws` dependency; a deployment/test harness passes a real factory.
   */
  webSocketServerFactory: (port: number) => WebSocketServerLike;
  port: number;
  /** Optional: observe agent-session reports (a real server persists for resume). */
  onAgentSession?: (info: { agentId: AgentId; sessionId: string; launchId: string }) => void;
  /** Optional: observe each inbound `ready` handshake/resync frame. */
  onReady?: (ready: HostReady) => void;
  /** Optional: observe `agent_wake_ack` frames (test assertions). */
  onWakeAck?: (info: { agentId: AgentId; launchId: string; status: AckStatus; error?: AckError }) => void;
  /** Optional: observe `agent_stopped_ack` frames (test assertions). */
  onStoppedAck?: (info: { agentId: AgentId; status: AckStatus; error?: AckError }) => void;
  /**
   * Authenticate a connecting daemon by its upgrade `Authorization` header
   * (`Bearer <machineKey>`). Returns true to accept. When provided, a connection
   * that fails is closed immediately — only key-bearing daemons reach the control
   * plane. Omitted ⇒ no auth (e.g. pure unit tests).
   */
  verifyMachineKey?: (authHeader: string | undefined) => boolean;
}

/**
 * Ws-transport shim for exactly one connected host at a time (the dev/test
 * case); a later host replaces the active socket. Commands are pushed
 * explicitly via `pushCommand` — there is no automatic dispatch, because
 * deciding WHEN to wake an agent is now `src/web`/`src/queue-worker`'s job in
 * production, not this fixture's.
 */
export class WsControlServer {
  private wss: WebSocketServerLike | null = null;
  private active: WebSocketLike | null = null;

  constructor(private readonly opts: WsControlServerOpts) {}

  start(): void {
    const wss = this.opts.webSocketServerFactory(this.opts.port);
    this.wss = wss;
    wss.on("connection", (socket, meta) => this.onConnection(socket, meta));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.active?.close();
      this.active = null;
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
  }

  get isConnected(): boolean {
    return this.active !== null;
  }

  /**
   * Send a `HostCommand` down to the currently connected daemon. Returns
   * false (no throw) when nothing is connected — callers (tests) decide
   * whether that's a failure.
   */
  pushCommand(cmd: HostCommand): boolean {
    if (!this.active) return false;
    try {
      this.active.send(JSON.stringify(cmd));
      return true;
    } catch {
      return false;
    }
  }

  private onConnection(socket: WebSocketLike, meta?: WsConnectionMeta): void {
    // Authenticate the daemon by its machine key before wiring anything up. A
    // connection without a valid key never reaches the control plane — this is
    // what stops anyone who can open the port from impersonating a host.
    if (this.opts.verifyMachineKey && !this.opts.verifyMachineKey(meta?.authHeader)) {
      try {
        socket.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }));
        socket.close();
      } catch {

      }
      return;
    }

    this.active = socket;

    socket.on("message", (data: unknown) => this.onMessage(data));
    socket.on("close", () => {
      if (this.active === socket) this.active = null;
    });
    socket.on("error", () => {

    });
  }

  private onMessage(data: unknown): void {
    let frame: InboundFrame | null = null;
    try {
      frame = JSON.parse(String(data)) as InboundFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;
    if (frame.type === "ready") {

      const { type: _type, ...ready } = frame;
      this.opts.onReady?.(ready);
    } else if (frame.type === "agent_session") {
      this.opts.onAgentSession?.({
        agentId: frame.agentId,
        sessionId: frame.sessionId,
        launchId: frame.launchId,
      });
    } else if (frame.type === "agent_wake_ack") {
      this.opts.onWakeAck?.({ agentId: frame.agentId, launchId: frame.launchId, status: frame.status, error: frame.error });
    } else if (frame.type === "agent_stopped_ack") {
      this.opts.onStoppedAck?.({ agentId: frame.agentId, status: frame.status, error: frame.error });
    }
  }
}
