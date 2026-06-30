import { DurableObject } from "cloudflare:workers"
import {
  createDb,
  queries,
  createLogger,
  COMMUNITY_MACHINE_HEARTBEAT_MS,
  COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
} from "@alook/shared"

const log = createLogger({ service: "ws-do" })

type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; userId: string; authenticated: boolean }
  | { type: "community-machine"; tokenId: string; userId: string; authenticated: boolean }

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

    if (url.pathname === "/force-close" && request.method === "POST") {
      let closed = 0
      for (const ws of this.ctx.getWebSockets()) {
        const s = ws.deserializeAttachment() as ConnectionState
        if (s?.type === "community-machine") {
          try {
            ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" }))
            ws.close(1008, "Revoked")
            closed++
          } catch { /* ok */ }
        }
      }
      return new Response(JSON.stringify({ closed }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }

    // Community-machine connections carry their auth token in `?token=`.
    const machineToken = url.searchParams.get("token")
    if (machineToken) {
      return this.acceptCommunityMachine(request, machineToken)
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

  private async acceptCommunityMachine(_request: Request, tokenId: string): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)

    // Validate token. Pending → claim; active → reuse; anything else → reject.
    const db = createDb(this.env.DB)
    let authResult: { tokenId: string; userId: string } | null = null
    try {
      const existing = await queries.communityMachine.findTokenById(db, tokenId)
      if (!existing) {
        this.rejectCommunityMachine(server, "unknown token")
        return new Response(null, { status: 101, webSocket: client })
      }
      if (existing.status === "pending") {
        try {
          authResult = await queries.communityMachine.claimPairingToken(db, tokenId)
        } catch {
          this.rejectCommunityMachine(server, "token claim failed")
          return new Response(null, { status: 101, webSocket: client })
        }
      } else if (existing.status === "active") {
        authResult = { tokenId: existing.tokenId, userId: existing.userId }
      } else {
        this.rejectCommunityMachine(server, "token revoked/expired")
        return new Response(null, { status: 101, webSocket: client })
      }
    } catch (err) {
      log.warn("community machine auth lookup failed", { err: String(err) })
      this.rejectCommunityMachine(server, "auth lookup failed")
      return new Response(null, { status: 101, webSocket: client })
    }

    server.serializeAttachment({
      type: "community-machine",
      tokenId: authResult.tokenId,
      userId: authResult.userId,
      authenticated: true,
    } as ConnectionState)

    // Note: do NOT setWebSocketAutoResponse — the new daemon uses WS-protocol
    // pings, which CF runtime answers transparently. Auto-response is only for
    // text-frame "ping"/"pong" used by the legacy CLI daemon path.

    // Schedule heartbeat alarm for last_seen_at refresh.
    await this.scheduleHeartbeatAlarm()

    return new Response(null, { status: 101, webSocket: client })
  }

  private rejectCommunityMachine(ws: WebSocket, reason: string): void {
    try {
      ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED", reason }))
    } catch { /* ok */ }
    try { ws.close(1008, "Unauthorized") } catch { /* ok */ }
  }

  private async scheduleHeartbeatAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    const want = Date.now() + COMMUNITY_MACHINE_HEARTBEAT_MS
    if (current == null || current > want) {
      await this.ctx.storage.setAlarm(want)
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return

    let parsed: unknown
    try { parsed = JSON.parse(message) } catch { ws.close(1008, "Invalid JSON"); return }

    const state = ws.deserializeAttachment() as ConnectionState

    if (state?.type === "community-machine") {
      await this.handleCommunityMachineMessage(state, parsed)
      return
    }

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
    if (state?.type === "community-machine" && state.authenticated) {
      log.info("community machine websocket closed", { tokenId: state.tokenId, userId: state.userId })
      // Update last_seen_at on close (best-effort) so the alarm path can
      // compute "stale enough to declare offline" against a real timestamp.
      try {
        const db = createDb(this.env.DB)
        await queries.communityMachine.touchMachineHeartbeat(
          db,
          state.userId,
          queries.communityMachine.machineUuidFromTokenId(state.tokenId)
        )
      } catch { /* ok */ }
      // Arm an offline-detection alarm exactly OFFLINE_THRESHOLD_MS out.
      // Overwrite any earlier (heartbeat) alarm — once the WS closes, the
      // heartbeat path has nothing to do, so the offline alarm wins.
      await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
    }
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets()
    const hasMachine = sockets.some((ws) => {
      const s = ws.deserializeAttachment() as ConnectionState
      return s?.type === "community-machine" && s.authenticated
    })

    if (hasMachine) {
      // Connection still live — refresh last_seen_at then reschedule.
      const db = createDb(this.env.DB)
      for (const ws of sockets) {
        const s = ws.deserializeAttachment() as ConnectionState
        if (s?.type === "community-machine" && s.authenticated) {
          try {
            await queries.communityMachine.touchMachineHeartbeat(
              db,
              s.userId,
              queries.communityMachine.machineUuidFromTokenId(s.tokenId)
            )
          } catch { /* ok */ }
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_HEARTBEAT_MS)
      return
    }

    // No live community-machine WS — emit offline events for any of OUR
    // matching machine rows whose last_seen_at is stale; otherwise reschedule
    // a wakeup at the exact moment the row becomes stale.
    const stored = await this.ctx.storage.get<{ tokenId: string; userId: string; machineId: string }>(
      "community-machine-handle"
    )
    if (!stored) return
    const db = createDb(this.env.DB)
    const machine = await queries.communityMachine.getMachineByIdForUser(
      db,
      stored.userId,
      stored.machineId
    )
    if (!machine) {
      // Row was deleted — drop the handle so we don't keep waking up forever.
      await this.ctx.storage.delete("community-machine-handle")
      return
    }
    const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0
    const elapsed = Date.now() - lastSeen
    if (elapsed >= COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS) {
      const nowIso = new Date().toISOString()
      await this.notifyUserDO(stored.userId, {
        type: "community:machine.status",
        machineId: stored.machineId,
        status: "offline",
        lastSeenAt: machine.lastSeenAt ?? nowIso,
      }).catch(() => {})
      return
    }
    // Not stale yet — wake up again precisely when it will be.
    await this.ctx.storage.setAlarm(Date.now() + (COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS - elapsed))
  }

  private async handleCommunityMachineMessage(
    state: { type: "community-machine"; tokenId: string; userId: string; authenticated: boolean },
    parsed: unknown
  ): Promise<void> {
    const msg = parsed as { type?: string; ready?: Record<string, unknown> }
    if (msg.type !== "ready") return
    const ready = (msg.ready ?? {}) as Record<string, unknown>
    const hostname = typeof ready.hostname === "string" ? ready.hostname : ""
    const platform = typeof ready.os === "string" ? ready.os : ""
    const arch = typeof ready.arch === "string" ? ready.arch : ""
    const daemonVersion = typeof ready.daemonVersion === "string" ? ready.daemonVersion : ""
    const osRelease = typeof ready.osRelease === "string" ? ready.osRelease : ""

    const db = createDb(this.env.DB)
    const { machine, priorLastSeenAt } = await queries.communityMachine.upsertMachineForUser(
      db,
      state.userId,
      state.tokenId,
      { hostname, platform, arch, daemonVersion, osRelease }
    )
    await queries.communityMachine.touchTokenLastUsed(db, state.tokenId)

    const summary = queries.communityMachine.toSummary(machine)
    // Persist a small handle so alarm() (which has no WS to read state from)
    // can find the right machine row.
    await this.ctx.storage.put("community-machine-handle", {
      tokenId: state.tokenId,
      userId: state.userId,
      machineId: machine.id,
    })

    // First-time pair: broadcast created. Reconnect from stale: online transition.
    if (!priorLastSeenAt) {
      await this.notifyUserDO(state.userId, {
        type: "community:machine.created",
        machine: summary,
        tokenId: state.tokenId,
      }).catch(() => {})
    } else {
      const priorMs = Date.parse(priorLastSeenAt)
      const wasOffline = Number.isNaN(priorMs)
        ? true
        : Date.now() - priorMs >= COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS
      if (wasOffline) {
        await this.notifyUserDO(state.userId, {
          type: "community:machine.status",
          machineId: machine.id,
          status: "online",
          lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
        }).catch(() => {})
      }
    }
    await this.scheduleHeartbeatAlarm()
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

    // POST to each user's DO broadcast endpoint (batched to stay under subrequest limit)
    for (let i = 0; i < recipientUserIds.length; i += WebSocketDurableObject.SUBREQUEST_BATCH_SIZE) {
      const batch = recipientUserIds.slice(i, i + WebSocketDurableObject.SUBREQUEST_BATCH_SIZE)
      await Promise.all(
        batch.map((userId) => {
          const doId = this.env.WS_DO.idFromName("user:" + userId)
          const stub = this.env.WS_DO.get(doId)
          return stub.fetch(new Request("http://internal/broadcast", {
            method: "POST",
            body: event,
          })).catch(() => {})
        })
      )
    }
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

  private static readonly SUBREQUEST_BATCH_SIZE = 40

  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    const coMembers = await this.getCoMembers(userId)
    if (coMembers.length === 0) return
    const payload = JSON.stringify({ type: "community:presence.update", userId, online })
    for (let i = 0; i < coMembers.length; i += WebSocketDurableObject.SUBREQUEST_BATCH_SIZE) {
      const batch = coMembers.slice(i, i + WebSocketDurableObject.SUBREQUEST_BATCH_SIZE)
      await Promise.allSettled(
        batch.map((memberId) => {
          const doId = this.env.WS_DO.idFromName("user:" + memberId)
          const stub = this.env.WS_DO.get(doId)
          return stub.fetch(new Request("http://internal/broadcast", {
            method: "POST",
            body: payload,
          }))
        })
      )
    }
  }

  private async getCoMembers(userId: string): Promise<string[]> {
    const db = createDb(this.env.DB)
    return queries.communityMember.getCoMemberUserIds(db, userId)
  }

  private async sendPresenceSnapshot(ws: WebSocket, userId: string): Promise<void> {
    const coMembers = await this.getCoMembers(userId)
    if (coMembers.length === 0) return
    const onlineIds: string[] = []
    for (let i = 0; i < coMembers.length; i += WebSocketDurableObject.SUBREQUEST_BATCH_SIZE) {
      const batch = coMembers.slice(i, i + WebSocketDurableObject.SUBREQUEST_BATCH_SIZE)
      const checks = await Promise.allSettled(
        batch.map(async (memberId) => {
          const doId = this.env.WS_DO.idFromName("user:" + memberId)
          const stub = this.env.WS_DO.get(doId)
          const resp = await stub.fetch(new Request("http://internal/check-user-online"))
          const { online } = await resp.json() as { online: boolean }
          return online ? memberId : null
        })
      )
      for (const r of checks) {
        if (r.status === "fulfilled" && r.value) onlineIds.push(r.value)
      }
    }
    for (const id of onlineIds) {
      ws.send(JSON.stringify({ type: "community:presence.update", userId: id, online: true }))
    }
  }
}
