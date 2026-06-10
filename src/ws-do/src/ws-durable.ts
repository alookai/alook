import { DurableObject } from "cloudflare:workers"
import { createDb, queries, createLogger } from "@alook/shared"

const log = createLogger({ service: "ws-do" })

type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; userId: string; authenticated: boolean }

export class WebSocketDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const body = await request.text()
      const sent = this.broadcast(body)
      return new Response(JSON.stringify({ sent }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname === "/check-alive") {
      const hasAuthDaemon = this.ctx.getWebSockets().some(ws => {
        const s = ws.deserializeAttachment() as ConnectionState
        return s?.type === "daemon" && s.authenticated
      })
      return new Response(JSON.stringify({ alive: hasAuthDaemon }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server)

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
        const authResult = await this.validateMachineToken(msg.machineToken, msg.daemonId)
        if (!authResult) {
          log.warn("daemon websocket auth failed", { daemonId: msg.daemonId })
          ws.close(1008, "Unauthorized")
          return
        }
        ws.serializeAttachment({ type: "daemon", daemonId: msg.daemonId, userId: authResult.userId, authenticated: true } as ConnectionState)
        log.info("daemon websocket authenticated", { daemonId: msg.daemonId })
        ws.send(JSON.stringify({ type: "auth.ok" }))

        this.notifyUserDO(authResult.userId, { type: "runtime.status", status: "online", daemonId: msg.daemonId }).catch(() => {})
        return
      }

      if (!msg.token) {
        ws.close(1008, "Unauthorized")
        return
      }
      const userId = await this.validateToken(msg.token)
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

    if (msg.type === "check_daemon_status" && state.type === "user") {
      const daemonId = await this.getDaemonIdForUser(state.userId)
      if (daemonId) {
        try {
          const daemonDoId = this.env.WS_DO.idFromName("daemon:" + daemonId)
          const daemonStub = this.env.WS_DO.get(daemonDoId)
          const resp = await daemonStub.fetch(new Request("http://internal/check-alive"))
          const { alive } = await resp.json() as { alive: boolean }
          if (alive) {
            ws.send(JSON.stringify({ type: "runtime.status", status: "online", daemonId }))
          }
        } catch {
          log.debug("check_daemon_status: failed to reach daemon DO", { daemonId })
        }
      }
      return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type === "daemon" && state.authenticated) {
      log.info("daemon websocket closed", { daemonId: state.daemonId })
      this.notifyUserDO(state.userId, { type: "runtime.status", status: "offline", daemonId: state.daemonId }).catch(() => {})
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    log.error("websocket error", { err: error instanceof Error ? error : String(error) })
    try { ws.close(1011, "Internal error") } catch {}
  }

  private broadcast(message: string): number {
    let sent = 0
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState
      if (state.authenticated) {
        try {
          ws.send(message)
          sent++
        } catch {}
      }
    }
    return sent
  }

  private async notifyUserDO(userId: string, payload: unknown): Promise<void> {
    const userDoId = this.env.WS_DO.idFromName("user:" + userId)
    const userStub = this.env.WS_DO.get(userDoId)
    await userStub.fetch(new Request("http://internal/broadcast", {
      method: "POST",
      body: JSON.stringify(payload),
    }))
  }

  private async getDaemonIdForUser(userId: string): Promise<string | null> {
    const db = createDb(this.env.DB)
    const token = await queries.machineToken.getLatestTokenForUser(db, userId)
    return token?.hostname || null
  }

  private async validateToken(token: string): Promise<string | null> {
    const db = createDb(this.env.DB)
    return queries.session.getValidSession(db, token)
  }

  private async validateMachineToken(token: string, daemonId: string): Promise<{ userId: string } | null> {
    if (!token.startsWith("al_")) return null
    const db = createDb(this.env.DB)
    const mt = await queries.machineToken.getMachineTokenByToken(db, token)
    if (!mt) return null
    if (mt.status !== "active" || !mt.workspaceId) return null
    const runtimes = await queries.runtime.getRuntimeIdsByDaemon(db, daemonId, mt.workspaceId)
    return runtimes.length > 0 ? { userId: mt.userId } : null
  }
}
