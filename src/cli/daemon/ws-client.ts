import { createLogger } from "../lib/logger.js";
import { DaemonPushMessageSchema } from "@alook/shared";
import type { DaemonPushMessage } from "@alook/shared";

const log = createLogger({ module: "ws-client" });

const WS_RECONNECT_INIT = 1000;
const WS_RECONNECT_MAX = 30_000;
const WS_PING_INTERVAL = 25_000;
const WS_LIVENESS_TIMEOUT = 50_000;
const WS_DO_DEV_PORT = 8789;

export interface DaemonWsClientOptions {
  serverURL: string;
  daemonId: string;
  machineToken: string;
  onMessage: (msg: DaemonPushMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

export class DaemonWsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = WS_RECONNECT_INIT;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private connected = false;
  private closed = false;

  constructor(private opts: DaemonWsClientOptions) {}

  getUrl(): string {
    const url = new URL(this.opts.serverURL);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocal) {
      return `ws://localhost:${WS_DO_DEV_PORT}/?daemonId=${this.opts.daemonId}`;
    }
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/api/ws/daemon?daemonId=${this.opts.daemonId}`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.closed) return;
    this.cleanup();

    const wsUrl = this.getUrl();
    log.info("connecting", { url: wsUrl });

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      log.warn("ws creation failed", { err: String(err) });
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.reconnectDelay = WS_RECONNECT_INIT;
      this.ws!.send(JSON.stringify({
        type: "auth",
        machineToken: this.opts.machineToken,
        daemonId: this.opts.daemonId,
      }));
      this.lastMessageAt = Date.now();
      this.startHeartbeat();
    });

    this.ws.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now();
      const str = typeof event.data === "string" ? event.data : "";
      if (str === "pong") return;

      try {
        const msg = JSON.parse(str);
        if (msg.type === "auth.ok") {
          log.info("authenticated");
          this.connected = true;
          this.opts.onConnected();
          return;
        }
        const parsed = DaemonPushMessageSchema.safeParse(msg);
        if (!parsed.success) {
          log.warn("invalid push message", { err: parsed.error.message });
          return;
        }
        this.opts.onMessage(parsed.data);
      } catch (err) {
        log.debug("message parse error", { err: String(err) });
      }
    });

    this.ws.addEventListener("error", () => {
      log.debug("ws error");
    });

    this.ws.addEventListener("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      if (wasConnected) {
        this.opts.onDisconnected();
      }
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });
  }

  close(): void {
    this.closed = true;
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(this.reconnectDelay, WS_RECONNECT_MAX);
    this.reconnectDelay = Math.min(delay * 2, WS_RECONNECT_MAX);
    const jitter = Math.random() * 500;
    log.debug("reconnecting", { delayMs: Math.round(delay + jitter) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay + jitter);
  }

  private startHeartbeat(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send("ping");
      }
    }, WS_PING_INTERVAL);

    this.livenessInterval = setInterval(() => {
      if (Date.now() - this.lastMessageAt > WS_LIVENESS_TIMEOUT) {
        log.warn("liveness timeout, closing");
        this.ws?.close();
      }
    }, 5_000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.livenessInterval) { clearInterval(this.livenessInterval); this.livenessInterval = null; }
  }
}
