/**
 * WsControlServer — the SERVER end of the control plane, over a real WebSocket.
 *
 * This is the network counterpart to wiring a host's `LocalControlChannel`
 * directly into a `MockServer` in-process. Instead, the server listens on a ws
 * port; a host connects with a `WsControlChannel`; and the two exchange the same
 * control-plane frames the local path used — only now over a real socket, so
 * local dev exercises the actual transport rather than an in-process shortcut.
 *
 * Frames (symmetric with `WsControlChannel`):
 *   - server → host:  the JSON `HostCommand` (`agent:start` / `agent:deliver` / `agent:stop`)
 *   - host → server:  `{ type:"ready", …HostReady }` | `{ type:"agent_session", … }`
 *
 * The server's command sink (`MockServer.attachHost`) is bridged to the connected
 * socket: every command the server computes is serialized and sent down the wire.
 * Inbound `ready` frames mark the host's running agents; `agent_session` frames
 * are forwarded to an optional observer (a real server would persist them).
 *
 * The ws server impl is injected (`WebSocketServerLike`) so this file carries no
 * hard `ws` dependency and stays unit-testable; `mock-server` passes a factory
 * built on the `ws` package.
 */
import type { HostCommand, HostReady, AgentId, WebSocketLike } from "./contract.js";
import type { MockServer } from "./mockServer.js";
// Re-export so existing importers of WebSocketLike from this module keep working.
export type { WebSocketLike } from "./contract.js";

/** Per-connection metadata extracted from the WS upgrade request. */
export interface WsConnectionMeta {
  /** The `Authorization` header on the upgrade request (e.g. `Bearer <machineKey>`). */
  authHeader?: string;
}

/**
 * The subset of a ws *server* this module uses (matches `ws`'s WebSocketServer).
 * The `connection` callback's second arg carries the upgrade request's auth
 * header so the control plane can authenticate the connecting daemon — the
 * factory adapter (in `mock-server`) pulls it off the `ws` upgrade request.
 */
export interface WebSocketServerLike {
  on(event: "connection", cb: (socket: WebSocketLike, meta?: WsConnectionMeta) => void): void;
  close(cb?: () => void): void;
}

/** Inbound (host → server) control frames. `ready` fields are spread flat — see `WsControlChannel`. */
type InboundFrame =
  | ({ type: "ready" } & HostReady)
  | { type: "agent_session"; agentId: AgentId; sessionId: string; launchId: string }
  | { type: "agent_deliver_ack"; agentId: AgentId; deliveryId: string };

export interface WsControlServerOpts {
  /** The server whose control plane is exposed over ws. */
  server: MockServer;
  /**
   * Build the ws server bound to `port` on loopback. Injected so this module has
   * no hard `ws` dependency; `mock-server` passes a real factory.
   */
  webSocketServerFactory: (port: number) => WebSocketServerLike;
  port: number;
  /** Optional: observe agent-session reports (a real server persists for resume). */
  onAgentSession?: (info: { agentId: AgentId; sessionId: string; launchId: string }) => void;
  /**
   * Authenticate a connecting daemon by its upgrade `Authorization` header
   * (`Bearer <machineKey>`). Returns true to accept. When provided, a connection
   * that fails is closed immediately — only key-bearing daemons reach the control
   * plane. Omitted ⇒ no auth (e.g. pure unit tests).
   */
  verifyMachineKey?: (authHeader: string | undefined) => boolean;
}

/**
 * Bridges a `MockServer`'s control plane onto a ws server. One connected host at
 * a time (the dev case); a later host replaces the active sink.
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

  private onConnection(socket: WebSocketLike, meta?: WsConnectionMeta): void {
    // Authenticate the daemon by its machine key before wiring anything up. A
    // connection without a valid key never reaches the control plane — this is
    // what stops anyone who can open the port from impersonating a host.
    if (this.opts.verifyMachineKey && !this.opts.verifyMachineKey(meta?.authHeader)) {
      try {
        socket.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }));
        socket.close();
      } catch {
        /* already gone */
      }
      return;
    }

    this.active = socket;

    // Bridge server→host commands onto this socket.
    this.opts.server.attachHost((cmd: HostCommand) => {
      if (this.active === socket) {
        try {
          socket.send(JSON.stringify(cmd));
        } catch {
          /* socket gone; the close handler clears it */
        }
      }
    });

    socket.on("message", (data: unknown) => this.onMessage(data));
    socket.on("close", () => {
      if (this.active === socket) this.active = null;
    });
    socket.on("error", () => {
      /* close handler clears the socket */
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
      // (Re)connect handshake: REPLACE the running set with what the host reports
      // (idempotent refresh, not additive — a reconnect after a crash may report
      // fewer agents), then re-push any still-unacked deliveries to the host.
      this.opts.server.resetRunningAgents(frame.runningAgents);
      this.opts.server.redeliverUnacked();
    } else if (frame.type === "agent_session") {
      this.opts.onAgentSession?.({
        agentId: frame.agentId,
        sessionId: frame.sessionId,
        launchId: frame.launchId,
      });
    } else if (frame.type === "agent_deliver_ack") {
      this.opts.server.ackDelivery(frame.deliveryId);
    }
  }
}
