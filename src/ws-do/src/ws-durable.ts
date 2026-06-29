import { DurableObject } from "cloudflare:workers"
import { createDb, queries, createLogger } from "@alook/shared"
import type { CommunityTypingStart, CommunityPresenceUpdate } from "@alook/shared"

const log = createLogger({ service: "ws-do" })

type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; userId: string; authenticated: boolean }

export class WebSocketDurableObject extends DurableObject<Env> {
  /**
   * Ephemeral typing dedup: channelId/dmConversationId/threadId -> userId -> last timestamp.
   * Lost on DO eviction — acceptable, gracefully degraded (typing just re-fires).
   */
  private typingDedup = new Map<string, Map<string, number>>()

  /** Typing dedup window: 8 seconds */
  private static readonly TYPING_DEDUP_MS = 8_000

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

    if (url.pathname === "/check-user-online") {
      const hasAuthUser = this.ctx.getWebSockets().some(ws => {
        const s = ws.deserializeAttachment() as ConnectionState
        return s?.type === "user" && s.authenticated
      })
      return new Response(JSON.stringify({ online: hasAuthUser }), {
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
      const wasOnline = this.countAuthenticatedUserConnections(userId) > 0
      ws.serializeAttachment({ type: "user", userId, authenticated: true } as ConnectionState)
      log.info("websocket authenticated", { userId })
      ws.send(JSON.stringify({ type: "auth.ok" }))
      if (!wasOnline) {
        this.broadcastPresence(userId, true).catch(() => {})
      }
      // Send presence snapshot of online co-members
      this.sendPresenceSnapshot(ws, userId).catch(() => {})
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

    // ── Community: typing.start — dedup and fan-out ─────────────────────────
    if (msg.type === "community:typing.start" && state.type === "user") {
      const typingMsg = parsed as {
        type: string
        channelId?: string
        dmConversationId?: string
        threadId?: string
      }
      const scopeKey = typingMsg.channelId || typingMsg.dmConversationId || typingMsg.threadId
      if (!scopeKey) return

      // Per-user dedup: drop if last event from same user < 8s ago
      const now = Date.now()
      let scopeMap = this.typingDedup.get(scopeKey)
      if (!scopeMap) {
        scopeMap = new Map()
        this.typingDedup.set(scopeKey, scopeMap)
      }
      const lastTs = scopeMap.get(state.userId) || 0
      if (now - lastTs < WebSocketDurableObject.TYPING_DEDUP_MS) return
      scopeMap.set(state.userId, now)

      // Prune stale scopes to prevent unbounded growth
      if (this.typingDedup.size > 200) {
        for (const [key, map] of this.typingDedup) {
          let allStale = true
          for (const ts of map.values()) {
            if (now - ts < WebSocketDurableObject.TYPING_DEDUP_MS * 4) {
              allStale = false
              break
            }
          }
          if (allStale) this.typingDedup.delete(key)
        }
      }

      // Fan out: resolve recipients and POST to their user DOs.
      // The typing event is forwarded to the recipients' DOs which deliver it
      // via their existing broadcast path. The DO here only handles dedup.
      // Actual fan-out is performed by the web API layer that calls fanOutToChannel/DM.
      // However, for typing events sent directly over WS (not via REST), we fan out here.
      const event = JSON.stringify({
        type: "community:typing.start",
        channelId: typingMsg.channelId || undefined,
        dmConversationId: typingMsg.dmConversationId || undefined,
        threadId: typingMsg.threadId || undefined,
        userId: state.userId,
      })

      // Resolve recipients and broadcast
      this.fanOutTyping(state.userId, typingMsg.channelId, typingMsg.dmConversationId, typingMsg.threadId, event).catch((err) => {
        log.warn("community:typing.start fan-out failed", { err: String(err) })
      })
      return
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type === "daemon" && state.authenticated) {
      log.info("daemon websocket closed", { daemonId: state.daemonId })
      this.notifyUserDO(state.userId, { type: "runtime.status", status: "offline", daemonId: state.daemonId }).catch(() => {})
    }
    if (state?.type === "user" && state.authenticated) {
      const remaining = this.countAuthenticatedUserConnections(state.userId) - 1
      if (remaining <= 0) {
        this.broadcastPresence(state.userId, false).catch(() => {})
      }
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

  /**
   * Fan out a typing event to the appropriate recipients.
   * For channel/thread: resolve channel -> server -> members.
   * For DM: resolve the 2 participants.
   * Excludes the sender.
   */
  private async fanOutTyping(
    senderUserId: string,
    channelId?: string,
    dmConversationId?: string,
    threadId?: string,
    event?: string
  ): Promise<void> {
    if (!event) return
    const db = createDb(this.env.DB)
    let recipientUserIds: string[] = []

    if (dmConversationId) {
      const dm = await queries.communityDm.getDM(db, dmConversationId)
      if (dm) {
        recipientUserIds = [dm.user1Id, dm.user2Id].filter(Boolean) as string[]
      }
    } else {
      // Both threadId and channelId resolve to a channel after thread→channel unification
      const targetId = threadId || channelId
      if (targetId) {
        const channel = await queries.communityChannel.getChannel(db, targetId)
        if (channel) {
          const members = await queries.communityMember.listMembers(db, channel.serverId)
          recipientUserIds = members.map((m) => m.userId)
        }
      }
    }

    // Exclude the sender
    recipientUserIds = recipientUserIds.filter((id) => id !== senderUserId)
    if (recipientUserIds.length === 0) return

    // POST to each user's DO broadcast endpoint
    await Promise.all(
      recipientUserIds.map((userId) => {
        const doId = this.env.WS_DO.idFromName("user:" + userId)
        const stub = this.env.WS_DO.get(doId)
        return stub.fetch(new Request("http://internal/broadcast", {
          method: "POST",
          body: event,
        })).catch(() => {})
      })
    )
  }

  private countAuthenticatedUserConnections(userId: string): number {
    let count = 0
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState
      if (state?.type === "user" && state.authenticated && state.userId === userId) {
        count++
      }
    }
    return count
  }

  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    const coMembers = await this.getCoMembers(userId)
    if (coMembers.length === 0) return
    const payload = JSON.stringify({ type: "community:presence.update", userId, online })
    await Promise.allSettled(
      coMembers.map((memberId) => {
        const doId = this.env.WS_DO.idFromName("user:" + memberId)
        const stub = this.env.WS_DO.get(doId)
        return stub.fetch(new Request("http://internal/broadcast", {
          method: "POST",
          body: payload,
        }))
      })
    )
  }

  private async getCoMembers(userId: string): Promise<string[]> {
    const result = await this.env.DB.prepare(
      `SELECT DISTINCT sm2.user_id FROM community_server_member sm1
       JOIN community_server_member sm2 ON sm1.server_id = sm2.server_id
       WHERE sm1.user_id = ? AND sm2.user_id != ?`
    ).bind(userId, userId).all<{ user_id: string }>()
    return result.results.map((r) => r.user_id)
  }

  private async sendPresenceSnapshot(ws: WebSocket, userId: string): Promise<void> {
    const coMembers = await this.getCoMembers(userId)
    if (coMembers.length === 0) return
    const checks = await Promise.allSettled(
      coMembers.map(async (memberId) => {
        const doId = this.env.WS_DO.idFromName("user:" + memberId)
        const stub = this.env.WS_DO.get(doId)
        const resp = await stub.fetch(new Request("http://internal/check-user-online"))
        const { online } = await resp.json() as { online: boolean }
        return online ? memberId : null
      })
    )
    const onlineIds = checks
      .map((r) => r.status === "fulfilled" ? r.value : null)
      .filter(Boolean) as string[]
    if (onlineIds.length > 0) {
      for (const id of onlineIds) {
        ws.send(JSON.stringify({ type: "community:presence.update", userId: id, online: true }))
      }
    }
  }
}
