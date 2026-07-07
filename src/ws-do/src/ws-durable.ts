import { DurableObject } from "cloudflare:workers"
import {
  createDb,
  queries,
  createLogger,
  COMMUNITY_MACHINE_HEARTBEAT_MS,
  COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
  HostReadyMessageSchema,
  SessionErrorFrameSchema,
} from "@alook/shared"
import type { CommunityMachineRuntime, CommunityMachineSummary } from "@alook/shared"

/**
 * Order-normalized JSON for comparing two runtime lists. Includes `status`
 * and `lastError` in the canonical form so a runtime flipping healthy →
 * unhealthy (with the same id + version) still trips the diff and fans out
 * `community:machine.updated`. See plans/community-machine-presence-fix.md.
 */
function canonicalRuntimes(list: CommunityMachineRuntime[]): string {
  const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return JSON.stringify(
    sorted.map((r) => ({
      id: r.id,
      ...(r.version !== undefined ? { version: r.version } : {}),
      status: r.status ?? "healthy",
      ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
    }))
  )
}

const log = createLogger({ service: "ws-do" })

type ConnectionState =
  | { type: "user"; userId: string; authenticated: boolean }
  | { type: "daemon"; daemonId: string; userId: string; authenticated: boolean }
  | {
      type: "community-machine"
      machineId: string
      userId: string
      authenticated: boolean
    }

/**
 * Persisted identity for the community-machine connection. Written once at
 * accept and read by every subsequent frame + alarm — the DB is only touched
 * for the ONE authentication lookup, not for each `ready`/heartbeat.
 */
interface CommunityMachineIdentity {
  userId: string
  machineId: string
  credentialHash: string
}

interface CommunityMachineHandle {
  userId: string
  machineId: string
}

/** DO storage keys. */
const IDENTITY_KEY = "community-machine-identity"
const HANDLE_KEY = "community-machine-handle"
const RUNTIME_ERROR_KEY = "community-machine-runtime-error"

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
      const closed = await this.forceCloseCommunityMachine()
      return new Response(JSON.stringify({ closed }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname === "/push" && request.method === "POST") {
      // Forward a bot:* frame (or any host-command frame) to the connected
      // daemon. Best-effort — if the daemon isn't connected, drops silently.
      // Cold-start warmup on reconnect re-syncs authoritative state.
      const body = await request.text()
      const sent = this.forwardToCommunityMachine(body)
      return new Response(JSON.stringify({ sent }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname === "/forward-agent-start" && request.method === "POST") {
      // Forward an `agent:start` frame to the connected daemon and clear
      // any lastRuntimeError overlay optimistically (with a fan-out) so the
      // web card stops rendering the stale error immediately. If the daemon
      // replies with another `session.error`, the overlay is re-stashed on
      // the next inbound frame.
      const body = await request.text()
      const sent = this.forwardToCommunityMachine(body)
      await this.clearRuntimeErrorOverlay().catch(() => {})
      return new Response(JSON.stringify({ sent }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 })
    }

    // Community-machine connections carry `Authorization: Bearer cmk_...`.
    // The router named this DO from `sha256(bearer).slice(0,32)` without
    // hitting D1; the DO is the source of truth and runs the ONE D1 lookup
    // by full 64-hex hash on first accept, then caches identity in
    // ctx.storage for the rest of the connection's life.
    const authHeader = request.headers.get("Authorization")
    if (authHeader?.startsWith("Bearer cmk_")) {
      return this.acceptCommunityMachine(authHeader.slice(7).trim())
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

  private async acceptCommunityMachine(bearer: string): Promise<Response> {
    // Look up by full sha256 hash. Cached identity in ctx.storage lets every
    // subsequent frame skip D1 entirely. On network flake the DB throws —
    // reject with 503 so the daemon reconnects via the normal path.
    const db = createDb(this.env.DB)
    const hash = await queries.communityMachine.hashCredential(bearer)
    let auth: {
      credentialId: string
      userId: string
      machineId: string
      credentialHash: string
      doName: string
    } | null = null
    try {
      auth = await queries.communityMachine.findCredentialByHash(db, hash)
    } catch (err) {
      log.warn("community machine auth lookup threw", { err: String(err) })
      return new Response("auth lookup unavailable", { status: 503 })
    }
    if (!auth) {
      // 401 BEFORE `acceptWebSocket` — no socket enters ready state, no
      // alarm scheduled, no ctx.storage writes.
      return new Response("credential revoked or unknown", { status: 401 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)

    server.serializeAttachment({
      type: "community-machine",
      machineId: auth.machineId,
      userId: auth.userId,
      authenticated: true,
    } as ConnectionState)

    const identity: CommunityMachineIdentity = {
      userId: auth.userId,
      machineId: auth.machineId,
      credentialHash: auth.credentialHash,
    }
    await this.ctx.storage.put(IDENTITY_KEY, identity)
    // Write the offline-detection handle at accept, BEFORE arming the alarm,
    // so `alarm()` can always resolve identity even if `ready` never lands.
    await this.ctx.storage.put<CommunityMachineHandle>(HANDLE_KEY, {
      userId: auth.userId,
      machineId: auth.machineId,
    })

    // Note: do NOT setWebSocketAutoResponse — the daemon uses WS-protocol
    // pings, which CF runtime answers transparently.
    await this.scheduleHeartbeatAlarm()

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Close every community-machine attachment and drop cached identity /
   * runtime-error state, then fan out a `machine.updated` clearing the
   * lastRuntimeError overlay. Called via /force-close from the web-side
   * revoke path (which resolves the DO name from `credential.do_name`).
   */
  private async forceCloseCommunityMachine(): Promise<number> {
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
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
    // Drop cached state so a future accept-then-reject leaves nothing behind.
    await this.ctx.storage.delete(IDENTITY_KEY)
    await this.ctx.storage.delete(HANDLE_KEY)
    const hadError = (await this.ctx.storage.get(RUNTIME_ERROR_KEY)) !== undefined
    await this.ctx.storage.delete(RUNTIME_ERROR_KEY)
    // If we knew the user, clear any stale lastRuntimeError overlay from the
    // web card by re-fanning the summary with no overlay.
    if (identity && hadError) {
      await this.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => {})
    }
    return closed
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
      await this.handleCommunityMachineMessage(parsed)
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
      // Send presence snapshot of online co-members + friends
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
      log.info("community machine websocket closed", { machineId: state.machineId, userId: state.userId })
      // Presence source of truth: the WS connection. On close, flip the row
      // status='online' → 'offline' scoped by the credential hash the DO owns.
      // The scope guard ensures a rotated-credential reconnect (which lands
      // on a DIFFERENT DO instance) is not clobbered by this DO's late close.
      //
      // See plans/community-machine-presence-fix.md for the full model.
      const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
      if (!identity) {
        // No identity means we never fully accepted this connection (auth
        // failed before we cached it) OR the DO was already cleaned up. No
        // recoverable work for the alarm path here — HANDLE_KEY is written
        // alongside IDENTITY_KEY, so if identity is gone the alarm has
        // nothing to act on. Drop and return.
        return
      }
      try {
        const db = createDb(this.env.DB)
        const flipped = await queries.communityMachine.markMachineOffline(db, {
          userId: identity.userId,
          machineId: identity.machineId,
          credentialHash: identity.credentialHash,
        })
        if (flipped) {
          // Real transition — broadcast + clean up storage. Alarm no longer needed.
          await this.notifyUserDO(identity.userId, {
            type: "community:machine.status",
            machineId: identity.machineId,
            status: "offline",
            lastSeenAt: flipped.lastSeenAt ?? new Date().toISOString(),
          }).catch(() => {})
          await this.ctx.storage.deleteAlarm()
          await this.ctx.storage.delete(HANDLE_KEY)
          await this.ctx.storage.delete(IDENTITY_KEY)
        } else {
          // No transition happened: row is already offline OR the credential
          // was revoked (rotation → another DO owns this machine now). Leave
          // storage alone; the alarm safety net catches any edge cases.
          await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
        }
      } catch (err) {
        log.warn("markMachineOffline failed on webSocketClose", { err: String(err) })
        // D1 error — leave the alarm armed so the safety-net path can retry.
        await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
      }
    }
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets()
    const liveMachines: Array<{ userId: string; machineId: string }> = []
    for (const ws of sockets) {
      const s = ws.deserializeAttachment() as ConnectionState
      if (s?.type === "community-machine" && s.authenticated) {
        liveMachines.push({ userId: s.userId, machineId: s.machineId })
      }
    }

    if (liveMachines.length > 0) {
      // Connection still live — refresh last_seen_at, then defense-in-depth:
      // opportunistically flip status='offline' → 'online' if the row is
      // stale-offline (e.g. hibernated across a deploy). Broadcast only on a
      // real transition; the steady state (status already online) is a no-op.
      const db = createDb(this.env.DB)
      const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
      for (const m of liveMachines) {
        try {
          await queries.communityMachine.touchMachineHeartbeat(db, m.userId, m.machineId)
        } catch { /* ok */ }
        if (identity && identity.userId === m.userId && identity.machineId === m.machineId) {
          try {
            const backfilled = await queries.communityMachine.markMachineOnlineIfOffline(db, {
              userId: identity.userId,
              machineId: identity.machineId,
              credentialHash: identity.credentialHash,
            })
            if (backfilled) {
              await this.notifyUserDO(identity.userId, {
                type: "community:machine.status",
                machineId: identity.machineId,
                status: "online",
                lastSeenAt: backfilled.lastSeenAt ?? new Date().toISOString(),
              }).catch(() => {})
            }
          } catch (err) {
            log.warn("markMachineOnlineIfOffline (alarm live-WS) failed", { err: String(err) })
          }
        }
      }
      await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_HEARTBEAT_MS)
      return
    }

    // No live community-machine WS — flip the row to offline if it's stale,
    // otherwise reschedule the alarm to the exact moment the row goes stale.
    const stored = await this.ctx.storage.get<CommunityMachineHandle>(HANDLE_KEY)
    if (!stored) return
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    const db = createDb(this.env.DB)
    const machine = await queries.communityMachine.getMachineByIdForUser(
      db,
      stored.userId,
      stored.machineId
    )
    if (!machine) {
      // Row was deleted — drop the handle so we don't keep waking up forever.
      await this.ctx.storage.delete(HANDLE_KEY)
      await this.ctx.storage.delete(IDENTITY_KEY)
      return
    }
    const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0
    const elapsed = Date.now() - lastSeen
    if (elapsed >= COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS) {
      // Stale enough — flip status='online' → 'offline' via the credential-scoped
      // query, broadcast only on real transition. If no identity is cached (e.g.
      // storage was wiped mid-lifecycle), fall back to a plain broadcast so the
      // UI still surfaces the transition even if the DB write skipped.
      if (identity) {
        try {
          const flipped = await queries.communityMachine.markMachineOffline(db, {
            userId: identity.userId,
            machineId: identity.machineId,
            credentialHash: identity.credentialHash,
          })
          if (flipped) {
            await this.notifyUserDO(stored.userId, {
              type: "community:machine.status",
              machineId: stored.machineId,
              status: "offline",
              lastSeenAt: flipped.lastSeenAt ?? new Date().toISOString(),
            }).catch(() => {})
          }
        } catch (err) {
          log.warn("markMachineOffline (alarm stale-flip) failed", { err: String(err) })
        }
      } else {
        // Identity was wiped mid-lifecycle but HANDLE_KEY still points at a
        // real row that is now stale. We can't run the credential-scoped
        // UPDATE, but the UI should still see the offline transition —
        // otherwise the machine chip stays green until reload. Broadcast
        // using the row's own lastSeenAt.
        await this.notifyUserDO(stored.userId, {
          type: "community:machine.status",
          machineId: stored.machineId,
          status: "offline",
          lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
        }).catch(() => {})
      }
      // In either branch, this DO's presence lifecycle is done. Drop storage
      // so a future connection on the same DO name starts clean.
      await this.ctx.storage.delete(HANDLE_KEY)
      await this.ctx.storage.delete(IDENTITY_KEY)
      return
    }
    // Not stale yet — wake up again precisely when it will be.
    await this.ctx.storage.setAlarm(Date.now() + (COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS - elapsed))
  }

  private async handleCommunityMachineMessage(parsed: unknown): Promise<void> {
    // Identity lives in ctx.storage — one D1 lookup at accept, zero here.
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    if (!identity) {
      log.warn("community machine message with no cached identity")
      return
    }

    // Agent command ack frames — daemon → server reply protocol. New in v0.2.
    // `agent_started_ack` / `agent_stopped_ack` / extended `agent_deliver_ack`
    // carry `status: "ok" | "error"` + optional `{ code, message }`.
    // No persistent write: there is no `communityAgentRuntime` table (checked)
    // and adding one is scope creep. Log for observability only; owner-visible
    // surfacing goes through the daemon-side error propagation to the bot
    // process (which can DM the owner).
    if (
      parsed && typeof parsed === "object" && "type" in parsed &&
      typeof (parsed as { type: unknown }).type === "string" &&
      (
        (parsed as { type: string }).type === "agent_started_ack" ||
        (parsed as { type: string }).type === "agent_stopped_ack" ||
        (parsed as { type: string }).type === "agent_deliver_ack"
      )
    ) {
      const ack = parsed as {
        type: string
        agentId?: string
        status?: string
        error?: { code?: string; message?: string }
      }
      if (ack.status === "error") {
        log.warn("agent command ack error", {
          machineId: identity.machineId,
          type: ack.type,
          agentId: ack.agentId,
          code: ack.error?.code,
          message: ack.error?.message,
        })
      } else if (ack.status === "ok") {
        log.debug("agent command ack ok", {
          machineId: identity.machineId,
          type: ack.type,
          agentId: ack.agentId,
        })
      }
      return
    }

    // `session.error` — daemon reports an unsupported runtime request.
    // Overlay it on the summary so the web card renders the error inline;
    // no DB writes (this is DO-local state).
    const sessionErrorParse = SessionErrorFrameSchema.safeParse(parsed)
    if (sessionErrorParse.success && sessionErrorParse.data.code === "runtime_not_available") {
      const payload = sessionErrorParse.data.payload ?? {}
      const requested = typeof payload.requested === "string" ? payload.requested : ""
      const availableRaw = Array.isArray(payload.available) ? payload.available : []
      const available = availableRaw.filter((v): v is string => typeof v === "string")
      const overlay = { requested, available, at: new Date().toISOString() }
      await this.ctx.storage.put(RUNTIME_ERROR_KEY, overlay)
      await this.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => {})
      return
    }

    // Otherwise: only `ready` frames drive DB updates. Zod-parse strictly —
    // legacy `runtimes: string[]`-only frames from pre-refactor daemons fail
    // validation and are silently dropped; MIN_CLI_VERSION will squeeze them
    // out on the next reconnect.
    const readyParse = HostReadyMessageSchema.safeParse(parsed)
    if (!readyParse.success) return
    const ready = readyParse.data
    const hostname = ready.hostname ?? ""
    const platform = ready.platform ?? ""
    const arch = ready.arch ?? ""
    const daemonVersion = ready.daemonVersion ?? ""
    const osRelease = ready.osRelease ?? ""
    const availableRuntimes: CommunityMachineRuntime[] = ready.runtimeReport

    const db = createDb(this.env.DB)
    const result = await queries.communityMachine.upsertMachineByMachineId(
      db,
      identity.userId,
      identity.machineId,
      { hostname, platform, arch, daemonVersion, osRelease, availableRuntimes }
    )
    if (!result) {
      // The machine row was deleted (or race) between credential validation
      // and this update — bail. The row will not be re-created here; the
      // daemon will be evicted on the next credential lookup via cascade.
      log.warn("community machine row missing on ready", { machineId: identity.machineId })
      return
    }
    const { machine, priorAvailableRuntimes, priorStatus } = result

    const summary = await this.summaryWithOverlay(machine)
    // Refresh the offline-detection handle in case metadata changed. Handle
    // was written at accept; this is idempotent.
    await this.ctx.storage.put<CommunityMachineHandle>(HANDLE_KEY, {
      userId: identity.userId,
      machineId: machine.id,
    })

    // NOTE: `community:machine.created` is emitted by the /activate route,
    // not here — activation is the single source of the create event and
    // carries the pairing token the client needs to reconcile its pending
    // state. Here we only handle status transitions and runtime drift.
    //
    // Broadcast the online transition ONLY when the row actually flipped
    // offline → online. `priorStatus` is the pre-upsert column value returned
    // by upsertMachineByMachineId; the upsert unconditionally sets
    // status='online', so `priorStatus !== 'online'` is the exact transition.
    if (priorStatus !== "online") {
      await this.notifyUserDO(identity.userId, {
        type: "community:machine.status",
        machineId: machine.id,
        status: "online",
        lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
      }).catch(() => {})
    }

    // Runtime-drift diff. Canonicalized form now includes status/lastError
    // so a runtime flipping healthy → unhealthy on subsequent ready frames
    // (e.g. ENOENT hit at spawn time) fans out `community:machine.updated`.
    const priorCanonical = canonicalRuntimes(priorAvailableRuntimes ?? [])
    const nextCanonical = canonicalRuntimes(availableRuntimes)
    if (priorCanonical !== nextCanonical) {
      await this.notifyUserDO(identity.userId, {
        type: "community:machine.updated",
        machine: summary,
      }).catch(() => {})
    }

    await this.scheduleHeartbeatAlarm()
  }

  /**
   * Compose a summary + the current DO-local `lastRuntimeError` overlay (if
   * any). The overlay is transient — cleared optimistically when the DO
   * forwards `agent:start` to the daemon, and on `forceClose`.
   */
  private async summaryWithOverlay(
    row: Parameters<typeof queries.communityMachine.toSummary>[0]
  ): Promise<CommunityMachineSummary> {
    const base = queries.communityMachine.toSummary(row)
    const overlay = await this.ctx.storage.get<{
      requested: string
      available: string[]
      at: string
    }>(RUNTIME_ERROR_KEY)
    return overlay ? { ...base, lastRuntimeError: overlay } : base
  }

  /**
   * Send a frame to the connected community-machine daemon (if any). Used by
   * `agent:start` forwarding — the community control plane isn't fully wired
   * yet, but the surface exists so the eventual emitter routes through here
   * (and picks up the optimistic overlay clear for free).
   */
  private forwardToCommunityMachine(message: string): number {
    let sent = 0
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState
      if (state?.type === "community-machine" && state.authenticated) {
        try {
          ws.send(message)
          sent++
        } catch { /* ok */ }
      }
    }
    return sent
  }

  /** Optimistic overlay clear — no-op when nothing is stashed. */
  private async clearRuntimeErrorOverlay(): Promise<void> {
    const overlay = await this.ctx.storage.get(RUNTIME_ERROR_KEY)
    if (overlay === undefined) return
    await this.ctx.storage.delete(RUNTIME_ERROR_KEY)
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    if (!identity) return
    await this.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => {})
  }

  /**
   * Fan out a fresh `community:machine.updated` for the row + current
   * overlay state. Used by session.error stash, optimistic clear on
   * `agent:start`, and forceClose.
   */
  private async fanOutMachineUpdated(userId: string, machineId: string): Promise<void> {
    const db = createDb(this.env.DB)
    const row = await queries.communityMachine.getMachineByIdForUser(db, userId, machineId)
    if (!row) return
    const summary = await this.summaryWithOverlay(row)
    await this.notifyUserDO(userId, {
      type: "community:machine.updated",
      machine: summary,
    })
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
    const audience = await this.getPresenceAudience(userId)
    if (audience.length === 0) return
    const payload = JSON.stringify({ type: "community:presence.update", userId, online })
    for (let i = 0; i < audience.length; i += WebSocketDurableObject.SUBREQUEST_BATCH_SIZE) {
      const batch = audience.slice(i, i + WebSocketDurableObject.SUBREQUEST_BATCH_SIZE)
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

  private async getFriendIds(userId: string): Promise<string[]> {
    const db = createDb(this.env.DB)
    return queries.communityFriendship.getFriendUserIds(db, userId)
  }

  /**
   * Who should learn about `userId`'s online/offline flips: server
   * co-members AND accepted friends. Friends are the common case that a
   * co-members-only audience misses entirely — two people can be friends
   * without ever sharing a server, which is the whole point of a friends
   * list. Deduped so a friend who's also a co-member gets one fetch, not two.
   */
  private async getPresenceAudience(userId: string): Promise<string[]> {
    const [coMembers, friends] = await Promise.all([
      this.getCoMembers(userId),
      this.getFriendIds(userId),
    ])
    return [...new Set([...coMembers, ...friends])]
  }

  private async sendPresenceSnapshot(ws: WebSocket, userId: string): Promise<void> {
    const audience = await this.getPresenceAudience(userId)
    if (audience.length === 0) return
    const onlineIds: string[] = []
    for (let i = 0; i < audience.length; i += WebSocketDurableObject.SUBREQUEST_BATCH_SIZE) {
      const batch = audience.slice(i, i + WebSocketDurableObject.SUBREQUEST_BATCH_SIZE)
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
