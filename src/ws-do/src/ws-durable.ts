import { DurableObject } from "cloudflare:workers"
import {
  createDb,
  queries,
  createLogger,
  COMMUNITY_MACHINE_HEARTBEAT_MS,
  COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
  HostReadyMessageSchema,
  SessionErrorFrameSchema,
  AgentActivityMessageSchema,
  AgentTypingMessageSchema,
  AgentTypingStopMessageSchema,
  AgentSessionMessageSchema,
  HostBotAuditEventFrameSchema,
  pickBotActivityPreset,
  RUNNING_PRESETS,
  isBotActivityStatus,
  WS_EVENTS,
  withD1Retry,
} from "@alook/shared"
import type { CommunityMachineRuntime, CommunityMachineSummary } from "@alook/shared"
import {
  HANDLE_KEY,
  IDENTITY_KEY,
  normalizeRestartAttribution,
  restartPendingKey,
  RUNTIME_ERROR_KEY,
} from "./ws-durable/internal"
import type {
  CommunityMachineConnectionState,
  CommunityMachineHandle,
  CommunityMachineIdentity,
  ConnectionState,
  ResetTrigger,
  RestartAttribution,
  WsDurableContext,
} from "./ws-durable/internal"
import {
  acceptUserWebSocket,
  handleUserFetch,
  handleWebSocketClose,
  handleWebSocketError,
  handleWebSocketMessage,
} from "./ws-durable/user-auth"
import {
  broadcastPresence,
  broadcastToAudience,
  fanOutTyping,
  fanOutTypingStop,
  getPresenceAudience,
  notifyUserDO,
  sendPresenceSnapshot,
} from "./ws-durable/presence-typing"

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

export class WebSocketDurableObject extends DurableObject<Env> {
  /**
   * Ephemeral typing dedup: channelId -> userId -> last timestamp.
   * Lost on DO eviction — acceptable, gracefully degraded (typing just re-fires).
   */
  private typingDedup = new Map<string, Map<string, number>>()

  /** Typing dedup window: 8 seconds */
  private static readonly TYPING_DEDUP_MS = 8_000

  private static readonly SUBREQUEST_BATCH_SIZE = 40

  private domainContext(): WsDurableContext {
    return {
      ctx: this.ctx,
      env: this.env,
      log,
      typingDedup: this.typingDedup,
      typingDedupMs: WebSocketDurableObject.TYPING_DEDUP_MS,
      subrequestBatchSize: WebSocketDurableObject.SUBREQUEST_BATCH_SIZE,
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const userResponse = await handleUserFetch(this.domainContext(), request, url)
    if (userResponse) return userResponse

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
      // Reset/nap/reset_all frames pass through here on their way to the daemon.
      // Persist attribution only when at least one daemon socket received them.
      // Starting the storage write before yielding keeps a fast completion
      // behind the Durable Object input gate.
      const sent = this.forwardToCommunityMachine(body)
      if (sent > 0) await this.recordPendingRestarts(body)
      return new Response(JSON.stringify({ sent }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/push-model-switch" || url.pathname === "/push-provider-switch")
    ) {
      let payload: unknown
      try {
        payload = await request.json()
      } catch {
        return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
      }
      if (!payload || typeof payload !== "object") {
        return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
      }
      const raw = payload as Record<string, unknown>
      const { agentId, config, launchId, from, to } = raw
      if (
        typeof agentId !== "string" || agentId.length === 0 ||
        typeof launchId !== "string" || launchId.length === 0 ||
        !config || typeof config !== "object"
      ) {
        return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
      }
      const providerSwitch = url.pathname === "/push-provider-switch"
      if (
        providerSwitch
          ? typeof from !== "string" || from.length === 0 || typeof to !== "string" || to.length === 0
          : (from !== null && typeof from !== "string") || (to !== null && typeof to !== "string")
      ) {
        return new Response(JSON.stringify({ sent: 0 }), { status: 400 })
      }
      const frame = JSON.stringify({
        type: providerSwitch ? "agent:reset" : "agent:model_switch",
        agentId,
        config,
        launchId,
      })
      const sent = this.forwardToCommunityMachine(frame)
      if (sent > 0) {
        const attribution: RestartAttribution = providerSwitch
          ? { kind: "provider_switch", from: from as string, to: to as string }
          : { kind: "model_switch", from: from as string | null, to: to as string | null }
        await this.ctx.storage.put<RestartAttribution>(restartPendingKey(launchId), attribution)
      }
      return new Response(JSON.stringify({ sent }), {
        headers: { "Content-Type": "application/json" },
      })
    }

    if (url.pathname === "/forward-agent-wake" && request.method === "POST") {
      // Forward an `agent:wake` frame to the connected daemon and clear
      // any lastRuntimeError overlay optimistically (with a fan-out) so the
      // web card stops rendering the stale error immediately. If the daemon
      // replies with another `session.error`, the overlay is re-stashed on
      // the next inbound frame.
      const body = await request.text()
      const sent = this.forwardToCommunityMachine(body)
      await this.clearRuntimeErrorOverlay().catch(() => { })
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

    return acceptUserWebSocket(this.domainContext())
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
      await this.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => { })
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
    await handleWebSocketMessage(
      this.domainContext(),
      ws,
      message,
      (parsed) => this.handleCommunityMachineMessage(parsed),
    )
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await handleWebSocketClose(
      this.domainContext(),
      ws,
      (state) => this.handleCommunityMachineClose(state),
    )
  }

  private async handleCommunityMachineClose(state: CommunityMachineConnectionState): Promise<void> {
    log.info("community machine websocket closed", { machineId: state.machineId, userId: state.userId })
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    if (!identity) return
    try {
      const db = createDb(this.env.DB)
      const flipped = await queries.communityMachine.markMachineOffline(db, {
        userId: identity.userId,
        machineId: identity.machineId,
        credentialHash: identity.credentialHash,
      })
      if (flipped) {
        await this.notifyUserDO(identity.userId, {
          type: WS_EVENTS.MACHINE_STATUS,
          machineId: identity.machineId,
          status: "offline",
          lastSeenAt: flipped.lastSeenAt ?? new Date().toISOString(),
        }).catch(() => { })
        await this.ctx.storage.deleteAlarm()
        await this.ctx.storage.delete(HANDLE_KEY)
        await this.ctx.storage.delete(IDENTITY_KEY)
      } else {
        await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
      }
    } catch (err) {
      log.warn("markMachineOffline failed on webSocketClose", { err: String(err) })
      await this.ctx.storage.setAlarm(Date.now() + COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS)
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
                type: WS_EVENTS.MACHINE_STATUS,
                machineId: identity.machineId,
                status: "online",
                lastSeenAt: backfilled.lastSeenAt ?? new Date().toISOString(),
              }).catch(() => { })
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
              type: WS_EVENTS.MACHINE_STATUS,
              machineId: stored.machineId,
              status: "offline",
              lastSeenAt: flipped.lastSeenAt ?? new Date().toISOString(),
            }).catch(() => { })
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
          type: WS_EVENTS.MACHINE_STATUS,
          machineId: stored.machineId,
          status: "offline",
          lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
        }).catch(() => { })
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

  /**
   * Shared scaffold for every daemon-reported bot frame (agent_activity,
   * agent_typing, agent_typing_stop, bot_audit_event):
   *
   *   1. resolve binding → if the query throws, log `phase=binding_check`
   *      under `ws_frame_dropped` and drop (never `_write` — the write
   *      never ran and this is a security-adjacent lookup failure).
   *   2. verify ownership → drop with a plain warn if `binding.machineId`
   *      doesn't match this DO's identity (frame-supplied agentId can't
   *      be trusted).
   *   3. run the frame-specific write → if it throws, log `phase=write`
   *      under `writeCategory` (`ws_frame_dropped_write` for audit events
   *      feeding the SLO, `ws_frame_dropped` for everything else).
   *
   * Centralized here so a new frame type CAN'T ship with the wrong log
   * category or a missing phase tag — the whole reason the discipline
   * exists.
   */
  private async handleFrameForBoundBot<B>(args: {
    frameType: string
    agentId: string
    machineId: string
    writeCategory?: "ws_frame_dropped" | "ws_frame_dropped_write"
    resolveBinding: () => Promise<B | null | undefined>
    isMatch: (binding: B) => boolean
    write: (binding: B) => Promise<void>
  }): Promise<void> {
    const { frameType, agentId, machineId, resolveBinding, isMatch, write } = args
    const writeCategory = args.writeCategory ?? "ws_frame_dropped"

    let binding: B | null | undefined
    try {
      binding = await resolveBinding()
    } catch (err) {
      log.warn("ws_frame_dropped", {
        category: "ws_frame_dropped",
        frame_type: frameType,
        phase: "binding_check",
        agentId,
        machineId,
        err: err instanceof Error ? err : new Error(String(err)),
      })
      return
    }
    if (!binding || !isMatch(binding)) {
      log.warn(`${frameType} frame for a bot not bound to this machine — dropped`, {
        agentId,
        machineId,
      })
      return
    }
    try {
      await write(binding)
    } catch (err) {
      log.warn("ws_frame_dropped", {
        category: writeCategory,
        frame_type: frameType,
        phase: "write",
        agentId,
        machineId,
        err: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }

  private async handleCommunityMachineMessage(parsed: unknown): Promise<void> {
    // Identity lives in ctx.storage — one D1 lookup at accept, zero here.
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    if (!identity) {
      log.warn("community machine message with no cached identity")
      return
    }

    // Agent command ack frames — daemon → server reply protocol. New in v0.2.
    // `agent_wake_ack` means "daemon accepted/handled the wake command," NOT
    // "process started" (a wake may spawn, notify an already-running
    // process, or coalesce for later — see `HostControlChannel.reportWakeAck`).
    // `agent_stopped_ack` carries `status: "ok" | "error"` + optional
    // `{ code, message }`. No persistent write: there is no
    // `communityAgentRuntime` table (checked) and adding one is scope creep.
    // Log for observability only; owner-visible surfacing goes through the
    // daemon-side error propagation to the bot process (which can DM the
    // owner). `agent_deliver_ack` no longer exists — the server never
    // decides start-vs-deliver, so there is nothing for the daemon to ack
    // beyond the wake command itself.
    if (
      parsed && typeof parsed === "object" && "type" in parsed &&
      typeof (parsed as { type: unknown }).type === "string" &&
      (
        (parsed as { type: string }).type === "agent_wake_ack" ||
        (parsed as { type: string }).type === "agent_stopped_ack"
      )
    ) {
      const ack = parsed as {
        type: string
        agentId?: string
        launchId?: string
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
        // Cold-start failure branch B (enroll fail / spawn threw): the reborn
        // agent will never emit `agent_session`, so evict any pending
        // reset/nap attribution for this launch — leaving it would leak an
        // entry in ctx.storage forever, and (correctly) no audit/awake is ever
        // written for a reset that never completed (red line ②). Branch A
        // (runtime_not_available) arrives as `session.error` below.
        if (ack.type === "agent_wake_ack" && typeof ack.launchId === "string" && ack.launchId.length > 0) {
          await this.evictPendingReset(ack.launchId)
        }
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
      // Cold-start failure branch A (runtime not installed): the agent never
      // reborns, so evict any pending reset/nap attribution for this launch —
      // the twin of the `agent_wake_ack` error evict above. This is the branch
      // that would otherwise leak (a runtime-missing reset of a bound-idle
      // agent is the common batch-reset failure — Blair #922). `launchId` is
      // carried on the frame now (Melisa's source half).
      const launchId = sessionErrorParse.data.launchId
      if (typeof launchId === "string" && launchId.length > 0) {
        await this.evictPendingReset(launchId)
      }
      await this.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => { })
      return
    }

    // `agent_activity` — daemon reports a bot's derived activity state.
    // Translated INTO the same `statusEmoji`/`statusText` fields humans use
    // (so bots and humans share one status pipeline end-to-end and the
    // client never branches on "is this a bot") and fanned out via
    // `community:status.update`. `running` picks a fun preset once here
    // and persists it, so every viewer sees the same phrase for that
    // episode — no client-side randomization, no jitter on re-open.
    //
    // Verify the reporting machine actually owns this bot before writing —
    // never trust the frame-supplied agentId blindly, matching how other
    // frames on this channel trust `identity` but not frame-supplied ids.
    const activityParse = AgentActivityMessageSchema.safeParse(parsed)
    if (activityParse.success) {
      const { agentId, state } = activityParse.data
      const db = createDb(this.env.DB)
      await this.handleFrameForBoundBot({
        frameType: "agent_activity",
        agentId,
        machineId: identity.machineId,
        resolveBinding: () => queries.communityBot.getBotBinding(db, agentId),
        isMatch: (binding) => binding.machineId === identity.machineId,
        write: async () => {
          const prior = await withD1Retry(
            () => queries.communityUserProfile.getProfile(db, agentId),
            { route: "ws-do:agent-activity-profile-read" },
          )
          const priorEmoji = prior?.statusEmoji ?? null
          // `status_text` defaults to "" (schema), so an unset status reads back
          // as (null, "") not (null, null). Normalize "" → null so "no status"
          // is treated uniformly as writable, not mistaken for a custom status.
          const priorText = prior?.statusText ? prior.statusText : null
          // The activity pipeline only owns pills it wrote itself. If the bot
          // carries an owner-set custom status (a non-preset pair), leave it —
          // matches the reconciler's declared intent and stops the heartbeat
          // re-assert from stomping a custom status every interval. An empty
          // pair (no status yet) is still writable.
          if (
            (priorEmoji !== null || priorText !== null) &&
            !isBotActivityStatus(priorEmoji, priorText)
          )
            return
          const priorIsRunning =
            priorEmoji !== null &&
            RUNNING_PRESETS.some((p) => p.emoji === priorEmoji && p.text === priorText)
          // For `running`, reuse the currently-persisted preset if it's already
          // one of the running variants — matches the "one phrase per episode"
          // invariant instead of re-rolling on every derived running transition
          // (turn_end → idle → wake → running fires this repeatedly).
          const preset =
            state === "running" && priorIsRunning
              ? { emoji: priorEmoji as string, text: priorText as string }
              : pickBotActivityPreset(state, Math.random())
          if (preset.emoji === priorEmoji && preset.text === priorText) return
          await withD1Retry(
            () => queries.communityUserProfile.updateProfile(db, agentId, {
              statusEmoji: preset.emoji,
              statusText: preset.text,
            }),
            { route: "ws-do:agent-activity-profile" },
          )
          await this.broadcastToAudience(agentId, {
            type: WS_EVENTS.STATUS_UPDATE,
            userId: agentId,
            statusEmoji: preset.emoji,
            statusText: preset.text,
          })
        },
      })
      return
    }

    // `agent_typing` / `agent_typing_stop` — daemon reports the bot is (or
    // stopped) actively working on a DM. Fan out `community:typing.start` /
    // `community:typing.stop` to the DM's peer. Deliberately does NOT traverse
    // the client-inbound 8s dedup gate at ws-durable.ts:367-419 — daemon meters
    // cadence (5s heartbeat), so gating here would cause pill flicker every
    // ~3s. Client-side auto-expire (`TYPING_INDICATOR_TIMEOUT_MS = 8000`)
    // recovers if a heartbeat is dropped.
    const typingParse = AgentTypingMessageSchema.safeParse(parsed)
    if (typingParse.success) {
      const { agentId, channelId } = typingParse.data
      const db = createDb(this.env.DB)
      await this.handleFrameForBoundBot({
        frameType: "agent_typing",
        agentId,
        machineId: identity.machineId,
        resolveBinding: () => withD1Retry(
          () => queries.communityBot.getBotBindingWithOwner(db, agentId),
          { route: "ws-do:agent-typing-binding" },
        ),
        isMatch: (binding) => binding.machineId === identity.machineId,
        write: async (binding) => {
          // Channel membership is enforced inside `fanOutTyping` — no need to
          // pre-query here at 5s cadence. `name`/`discriminator` ride from the
          // binding (already read above) so the client renders the bot's name
          // without a roster lookup — no per-event DB.
          const event = JSON.stringify({
            type: WS_EVENTS.TYPING_START,
            channelId,
            userId: agentId,
            name: binding.name,
            discriminator: binding.discriminator,
          })
          await this.fanOutTyping(agentId, channelId, event)
        },
      })
      return
    }
    const typingStopParse = AgentTypingStopMessageSchema.safeParse(parsed)
    if (typingStopParse.success) {
      const { agentId, channelId } = typingStopParse.data
      const db = createDb(this.env.DB)
      await this.handleFrameForBoundBot({
        frameType: "agent_typing_stop",
        agentId,
        machineId: identity.machineId,
        resolveBinding: () => withD1Retry(
          () => queries.communityBot.getBotBindingWithOwner(db, agentId),
          { route: "ws-do:agent-typing-stop-binding" },
        ),
        isMatch: (binding) => binding.machineId === identity.machineId,
        // Channel membership enforced inside `fanOutTypingStop`.
        write: () => this.fanOutTypingStop(agentId, channelId),
      })
      return
    }

    // `agent_session` — the restarted agent is really up and has a session. This
    // is the completion signal for a reset, nap, model switch, or provider switch: if this launch has pending
    // attribution (recorded at dispatch in `/push`), write its audit + awake
    // stamp + broadcast NOW (not at dispatch), then consume the entry so a
    // replayed `agent_session` for the same launch can't double-write
    // (fire-once, §6.1). A launch with no pending entry (an ordinary wake, or
    // an already-consumed reset) falls through with no write.
    const sessionParse = AgentSessionMessageSchema.safeParse(parsed)
    if (sessionParse.success) {
      const { agentId, launchId } = sessionParse.data
      // CLAIM-then-write: read the pending trigger AND consume it up front, in
      // one turn before any `await` on the write path. Two `agent_session`
      // frames for the same launch can arrive back-to-back (e.g. codex used to
      // announce a thread twice → two frames); the OLD order (get → await
      // write → evict) let both read a non-null trigger before either evicted →
      // both wrote the reset audit (the "two identical reset records" bug).
      // Deleting immediately after the get makes the claim atomic within this
      // object's single-threaded turn: the second frame reads null and returns.
      // (normalizer dedup removes the double-frame SOURCE; this makes the
      // consume race-proof for any future double-frame, cross-runtime.)
      const stored = await this.ctx.storage.get<ResetTrigger | RestartAttribution>(restartPendingKey(launchId))
      if (!stored) return
      const attribution = normalizeRestartAttribution(stored)
      await this.evictPendingReset(launchId)
      const db = createDb(this.env.DB)
      await this.handleFrameForBoundBot({
        frameType: "agent_session",
        agentId,
        machineId: identity.machineId,
        writeCategory: "ws_frame_dropped_write",
        resolveBinding: () => withD1Retry(
          () => queries.communityBot.getBotBindingWithOwner(db, agentId),
          { route: "ws-do:agent-session-binding" },
        ),
        isMatch: (binding) => binding.machineId === identity.machineId,
        write: async (binding) => {
          // Per-kind audit — nap and reset stay distinct kinds so my-bots reads
          // "slept" vs "was reset" (red line ④). actorId never travels: reset
          // is owner-only, so the actor IS the bot owner, resolved right here
          // from the binding (red line ⑥ — attribution stays server-side).
          const inserted = attribution.kind === "nap"
            ? await queries.communityBotAuditLog.insertBotAuditNap(db, { botId: agentId, launchId })
            : attribution.kind === "session_reset"
              ? await queries.communityBotAuditLog.insertBotAuditSessionReset(db, {
                  botId: agentId,
                  launchId,
                  trigger: attribution.trigger,
                })
              : attribution.kind === "model_switch"
                ? await queries.communityBotAuditLog.insertBotAuditModelChanged(db, {
                    botId: agentId,
                    launchId,
                    from: attribution.from,
                    to: attribution.to,
                  })
                : await queries.communityBotAuditLog.insertBotAuditProviderChanged(db, {
                    botId: agentId,
                    launchId,
                    from: attribution.from,
                    to: attribution.to,
                  })
          if (!inserted) return
          // Stamp awake (lastRefreshContextAt) in lockstep with the audit row,
          // using the row's createdAt so the my-bots "Awake Nh" indicator can
          // never drift from the audit event.
          if (attribution.kind !== "model_switch") {
            await queries.communityBot.touchBotRefreshContext(db, agentId, inserted.createdAt)
          }
          const payload = attribution.kind === "nap"
            ? { trigger: "nap" }
            : attribution.kind === "session_reset"
              ? { trigger: attribution.trigger }
              : { from: attribution.from, to: attribution.to }
          await this.notifyUserDO(binding.ownerUserId, {
            type: WS_EVENTS.BOT_AUDIT_EVENT,
            botId: agentId,
            id: inserted.id,
            kind: attribution.kind === "provider_switch"
              ? "provider_changed"
              : attribution.kind === "model_switch"
                ? "model_changed"
                : attribution.kind,
            payload,
            sessionId: null,
            launchId,
            createdAt: inserted.createdAt,
          }).catch(() => { })
        },
      })
      // (pending entry already consumed above, before the write — claim-first.)
      return
    }

    // `bot_audit_event` — daemon reports a bot activity event (cli_invocation,
    // tool_call, or thinking). Insert + rolling-500 prune land atomically via
    // `db.batch`; server stamps `createdAt` (never trust the daemon clock).
    // Fan the resulting row out to the OWNER ONLY (never `broadcastToAudience`
    // — that would leak per-bot activity to co-members + friends).
    const auditParse = HostBotAuditEventFrameSchema.safeParse(parsed)
    if (auditParse.success) {
      const frame = auditParse.data
      // Serialize BEFORE the shared scaffold — a non-serializable payload
      // (BigInt, circular ref, function) throwing here has nothing to do
      // with the audit-loss SLO and must not be logged under
      // `ws_frame_dropped_write`.
      let payload: string
      try {
        payload = JSON.stringify(frame.event.payload)
      } catch (err) {
        log.warn("ws_frame_dropped", {
          category: "ws_frame_dropped",
          frame_type: "bot_audit_event",
          phase: "serialize",
          agentId: frame.agentId,
          machineId: identity.machineId,
          err: err instanceof Error ? err : new Error(String(err)),
        })
        return
      }
      const db = createDb(this.env.DB)
      await this.handleFrameForBoundBot({
        frameType: "bot_audit_event",
        agentId: frame.agentId,
        machineId: identity.machineId,
        // `ws_frame_dropped_write` — the audit-loss SLO category. Emitted at
        // full-rate ingest via ws-do's `head_sampling_rate = 1.0` so a
        // low-rate drift doesn't hide behind 10% sampling. Binding-check
        // failures stay on the plain `ws_frame_dropped` category via the
        // helper's default.
        writeCategory: "ws_frame_dropped_write",
        resolveBinding: () => withD1Retry(
          () => queries.communityBot.getBotBindingWithOwner(db, frame.agentId),
          { route: "ws-do:bot-audit-binding" },
        ),
        isMatch: (binding) => binding.machineId === identity.machineId,
        write: async (binding) => {
          const inserted = await queries.communityBotAuditLog.insertBotActivityEventAndPrune(db, {
            botId: frame.agentId,
            sessionId: frame.sessionId ?? null,
            launchId: frame.launchId ?? null,
            kind: frame.event.kind,
            payload,
          })
          if (!inserted) return
          await this.notifyUserDO(binding.ownerUserId, {
            type: WS_EVENTS.BOT_AUDIT_EVENT,
            botId: frame.agentId,
            id: inserted.id,
            kind: frame.event.kind,
            payload: frame.event.payload,
            sessionId: frame.sessionId ?? null,
            launchId: frame.launchId ?? null,
            createdAt: inserted.createdAt,
          }).catch(() => { })
        },
      })
      return
    }

    // Otherwise: only `ready` frames drive DB updates. Zod-parse strictly —
    // legacy `runtimes: string[]`-only frames from pre-refactor daemons fail
    // validation and are silently dropped; MIN_CLI_VERSION will squeeze them
    // out on the next reconnect.
    const readyParse = HostReadyMessageSchema.safeParse(parsed)
    if (!readyParse.success) return
    const ready = readyParse.data
    try {
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

      // Coarse safety net for an `agent_activity` frame dropped mid-disconnect —
      // clear any bot on this machine whose current status pill looks like a
      // stale system-written activity pill AND who the daemon reports is NOT
      // running now. Live `agent_activity` pushes handle every non-`idle`
      // transition; the reconciler only ever writes `Idle`. Owner-set custom
      // statuses (identified by not matching the known bot presets) are left
      // alone. See plans/community-bot-status-telemetry.md.
      const activityChanges = await queries.communityMachine.reconcileBotActivityFromRunningAgents(
        db,
        machine.id,
        ready.runningAgents
      )
      await Promise.allSettled(
        activityChanges.map(({ botUserId, statusEmoji, statusText }) =>
          this.broadcastToAudience(botUserId, {
            type: WS_EVENTS.STATUS_UPDATE,
            userId: botUserId,
            statusEmoji,
            statusText,
          })
        )
      )

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
          type: WS_EVENTS.MACHINE_STATUS,
          machineId: machine.id,
          status: "online",
          lastSeenAt: machine.lastSeenAt ?? new Date().toISOString(),
        }).catch(() => { })
      }

      // Runtime-drift diff. Canonicalized form now includes status/lastError
      // so a runtime flipping healthy → unhealthy on subsequent ready frames
      // (e.g. ENOENT hit at spawn time) fans out `community:machine.updated`.
      const priorCanonical = canonicalRuntimes(priorAvailableRuntimes ?? [])
      const nextCanonical = canonicalRuntimes(availableRuntimes)
      if (priorCanonical !== nextCanonical) {
        await this.notifyUserDO(identity.userId, {
          type: WS_EVENTS.MACHINE_UPDATED,
          machine: summary,
        }).catch(() => { })
      }

      await this.scheduleHeartbeatAlarm()
    } catch (err) {
      log.warn("ws_frame_dropped", {
        category: "ws_frame_dropped",
        frame_type: "ready",
        phase: "write",
        machineId: identity.machineId,
        err: err instanceof Error ? err : new Error(String(err)),
      })
    }
  }

  /**
   * Compose a summary + the current DO-local `lastRuntimeError` overlay (if
   * any). The overlay is transient — cleared optimistically when the DO
   * forwards `agent:wake` to the daemon, and on `forceClose`.
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
   * `agent:wake` forwarding (minimal-wake-queue-unread-notice plan §3) — the
   * `alook-wake-worker` consumer POSTs an already-built `agent:wake`
   * `HostCommand` to `/forward-agent-wake`, which routes here.
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

  /**
   * Record pending reset/nap attribution from a frame about to be forwarded to
   * the daemon. Each launchId → its trigger, keyed by the frame type:
   *   - `agent:reset`        → one launch, trigger `single`
   *   - `machine:reset_all`  → N launches (resets[]), trigger `reset_all`
   *   - `agent:nap`          → one launch, trigger `nap`
   * Any other frame type is a no-op. The entry is consumed (deleted) when the
   * reborn `agent_session` lands, or evicted on a cold-start failure frame
   * (`agent_wake_ack` error / `session.error`). Best-effort parse — a malformed
   * frame just records nothing and forwards as before.
   */
  private async recordPendingRestarts(body: string): Promise<void> {
    let frame: unknown
    try {
      frame = JSON.parse(body)
    } catch {
      return
    }
    if (!frame || typeof frame !== "object") return
    const f = frame as { type?: unknown }
    const put = async (launchId: unknown, attribution: RestartAttribution) => {
      if (typeof launchId !== "string" || launchId.length === 0) return
      await this.ctx.storage.put<RestartAttribution>(restartPendingKey(launchId), attribution)
    }
    if (f.type === "agent:reset") {
      await put((f as { launchId?: unknown }).launchId, { kind: "session_reset", trigger: "single" })
    } else if (f.type === "agent:nap") {
      await put((f as { launchId?: unknown }).launchId, { kind: "nap" })
    } else if (f.type === "machine:reset_all") {
      const resets = (f as { resets?: unknown }).resets
      if (Array.isArray(resets)) {
        for (const r of resets) {
          if (r && typeof r === "object") {
            await put((r as { launchId?: unknown }).launchId, { kind: "session_reset", trigger: "reset_all" })
          }
        }
      }
    }
  }

  /** Drop a pending restart entry (consumed on completion, or evicted on failure). */
  private async evictPendingReset(launchId: string): Promise<void> {
    await this.ctx.storage.delete(restartPendingKey(launchId))
  }

  /** Optimistic overlay clear — no-op when nothing is stashed. */
  private async clearRuntimeErrorOverlay(): Promise<void> {
    const overlay = await this.ctx.storage.get(RUNTIME_ERROR_KEY)
    if (overlay === undefined) return
    await this.ctx.storage.delete(RUNTIME_ERROR_KEY)
    const identity = await this.ctx.storage.get<CommunityMachineIdentity>(IDENTITY_KEY)
    if (!identity) return
    await this.fanOutMachineUpdated(identity.userId, identity.machineId).catch(() => { })
  }

  /**
   * Fan out a fresh `community:machine.updated` for the row + current
   * overlay state. Used by session.error stash, optimistic clear on
   * `agent:wake`, and forceClose.
   */
  private async fanOutMachineUpdated(userId: string, machineId: string): Promise<void> {
    const db = createDb(this.env.DB)
    const row = await queries.communityMachine.getMachineByIdForUser(db, userId, machineId)
    if (!row) return
    const summary = await this.summaryWithOverlay(row)
    await this.notifyUserDO(userId, {
      type: WS_EVENTS.MACHINE_UPDATED,
      machine: summary,
    })
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await handleWebSocketError(this.domainContext(), ws, error)
  }

  private async notifyUserDO(userId: string, payload: unknown): Promise<void> {
    await notifyUserDO(this.domainContext(), userId, payload)
  }

  private async fanOutTyping(
    senderUserId: string,
    channelId?: string,
    event?: string
  ): Promise<void> {
    await fanOutTyping(this.domainContext(), senderUserId, channelId, event)
  }

  /**
   * Fan out an explicit `community:typing.stop` for a channel scope to its
   * recipients. Mirrors `fanOutTyping` but never traverses a dedup cache — a
   * stop must always land or the pill dangles until the client's 8s expiry.
   * A DM is a channel now; recipients are its relation='access' members.
   */
  private async fanOutTypingStop(
    senderUserId: string,
    channelId: string,
  ): Promise<void> {
    await fanOutTypingStop(this.domainContext(), senderUserId, channelId)
  }

  private async broadcastPresence(userId: string, online: boolean): Promise<void> {
    await broadcastPresence(this.domainContext(), userId, online)
  }

  /**
   * Fan a payload out to `userId`'s presence audience (co-members ∪ friends),
   * batched to stay under the subrequest limit. Factored out of
   * `broadcastPresence` so other per-audience events (e.g.
   * `community:bot.activity`) share the same batched-fetch loop.
   */
  private async broadcastToAudience(userId: string, payload: unknown): Promise<void> {
    await broadcastToAudience(this.domainContext(), userId, payload)
  }

  /**
   * Who should learn about `userId`'s online/offline flips: server
   * co-members AND accepted friends — where "friends" (`getFriendUserIds`)
   * already includes the owner↔own-bot implicit friendship (see
   * `queries/community/friendship.ts`), so a fresh bot with zero servers
   * still reaches its owner with no `isBot` branch needed here. Friends are
   * also the common case that a co-members-only audience misses entirely —
   * two people can be friends without ever sharing a server, which is the
   * whole point of a friends list. Deduped so a friend who's also a
   * co-member gets one fetch, not two.
   */
  private async getPresenceAudience(userId: string): Promise<string[]> {
    return getPresenceAudience(this.domainContext(), userId)
  }

  private async sendPresenceSnapshot(ws: WebSocket, userId: string): Promise<void> {
    await sendPresenceSnapshot(this.domainContext(), ws, userId)
  }
}
