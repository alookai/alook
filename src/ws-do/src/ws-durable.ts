import { DurableObject } from "cloudflare:workers"
import { createDb, queries, createLogger } from "@alook/shared"

const log = createLogger({ service: "ws-do" })

type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; authenticated: boolean }

export class WebSocketDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const body = await request.text()
      this.broadcast(body)
      return new Response("ok")
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server)

    // Connections start unauthenticated. Client must send {type:"auth",token}
    // before any other message. See webSocketMessage below.
    server.serializeAttachment({ type: "user", userId: "", authenticated: false } as ConnectionState)

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    )

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return

    let parsed: unknown
    try { parsed = JSON.parse(message) } catch { ws.close(1008, "Invalid JSON"); return }

    const state = ws.deserializeAttachment() as ConnectionState

    const msg = parsed as { type: string; token?: string; machineToken?: string; daemonId?: string }

    if (msg.type === "auth") {
      if (msg.machineToken && msg.daemonId) {
        const valid = await this.validateMachineToken(msg.machineToken, msg.daemonId)
        if (!valid) {
          log.warn("daemon websocket auth failed", { daemonId: msg.daemonId })
          ws.close(1008, "Unauthorized")
          return
        }
        ws.serializeAttachment({ type: "daemon", daemonId: msg.daemonId, authenticated: true } as ConnectionState)
        log.info("daemon websocket authenticated", { daemonId: msg.daemonId })
        ws.send(JSON.stringify({ type: "auth.ok" }))
        return
      }

      const userId = await this.validateToken(msg.token!)
      if (!userId) {
        log.warn("websocket auth failed")
        ws.close(1008, "Unauthorized")
        return
      }
      ws.serializeAttachment({ type: "user", userId, authenticated: true } as ConnectionState)
      log.info("websocket authenticated", { userId })
      ws.send(JSON.stringify({ type: "auth.ok" }))
      return
    }

    if (!state.authenticated) {
      ws.close(1008, "Not authenticated")
      return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type === "daemon" && state.authenticated) {
      log.info("daemon websocket closed", { daemonId: state.daemonId })
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log.error("websocket error", { err: error instanceof Error ? error : String(error) })
    try { ws.close(1011, "Internal error") } catch {}
  }

  private broadcast(message: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState
      if (state.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(message)
      }
    }
  }

  private async validateToken(token: string): Promise<string | null> {
    const db = createDb(this.env.DB)
    return queries.session.getValidSession(db, token)
  }

  private async validateMachineToken(token: string, daemonId: string): Promise<boolean> {
    if (!token.startsWith("al_")) return false
    const db = createDb(this.env.DB)
    const mt = await queries.machineToken.getMachineTokenByToken(db, token)
    if (!mt || mt.status !== "active" || !mt.workspaceId) return false
    const runtimes = await queries.runtime.getRuntimeIdsByDaemon(db, daemonId, mt.workspaceId)
    return runtimes.length > 0
  }
}
