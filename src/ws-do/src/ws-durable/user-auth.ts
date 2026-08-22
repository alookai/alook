import {
  createDb,
  encodePreparedCommunityBrowserEventBatch,
  isValidCommunityUserTarget,
  queries,
  readOrStale,
  withD1Retry,
} from "@alook/shared"
import {
  createCommunityDeliveryReceipt,
  type CommunityDeliverySocketResult,
} from "../community-delivery-receipt"
import type {
  CommunityMachineConnectionState,
  ConnectionState,
  WsDurableContext,
} from "./internal"
import {
  broadcastPresence,
  handleClientTypingStart,
  notifyUserDO,
  sendPresenceSnapshot,
} from "./presence-typing"
import {
  getInternalCommunityUserTarget,
  getInternalUserTarget,
} from "../internal-user-broadcast"
import {
  invalidCommunityBrowserEventResponse,
  logCommunityBrowserEventRejected,
  readCommunityBrowserEventBundleRequest,
  readCommunityBrowserEventRequest,
} from "../community-browser-event-ingress"
import {
  preflightCommunityConnectionState,
  readCommunityDeliveryProgress,
  withCommunityDeliveryProgress,
  type CommunityDeliveryProgress,
} from "./community-delivery-state"

export async function handleUserFetch(
  context: WsDurableContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/community-broadcast-bundle" && request.method === "POST") {
    const targetUserId = getInternalCommunityUserTarget(request)
    if (!isValidCommunityUserTarget(targetUserId)) {
      const failure = { ok: false, reason: "invalid-target", type: "unknown" } as const
      logCommunityBrowserEventRejected(context.log, "target-do-bundle", failure)
      return deliveryErrorResponse(400, { operationId: null, code: "invalid_request" })
    }
    const bundle = await readCommunityBrowserEventBundleRequest(request)
    if (!bundle.ok) {
      logCommunityBrowserEventRejected(context.log, "target-do-bundle", bundle)
      return deliveryErrorResponse(400, { operationId: null, code: "invalid_request" })
    }
    return deliverCommunityBundle(context, bundle, targetUserId)
  }

  if (url.pathname === "/community-broadcast" && request.method === "POST") {
    const targetUserId = getInternalCommunityUserTarget(request)
    if (!isValidCommunityUserTarget(targetUserId)) {
      const failure = { ok: false, reason: "invalid-target", type: "unknown" } as const
      logCommunityBrowserEventRejected(context.log, "target-do", failure)
      return invalidCommunityBrowserEventResponse(failure)
    }
    const event = await readCommunityBrowserEventRequest(request)
    if (!event.ok) {
      logCommunityBrowserEventRejected(context.log, "target-do", event)
      return invalidCommunityBrowserEventResponse(event)
    }
    const sent = broadcast(context, event.body, targetUserId)
    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/broadcast" && request.method === "POST") {
    const body = await request.text()
    const sent = broadcast(context, body, getInternalUserTarget(request))
    return new Response(JSON.stringify({ sent }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/check-alive") {
    const hasAuthDaemon = context.ctx.getWebSockets().some(ws => {
      const s = ws.deserializeAttachment() as ConnectionState
      return s?.type === "daemon" && s.authenticated
    })
    return new Response(JSON.stringify({ alive: hasAuthDaemon }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  if (url.pathname === "/check-user-online") {
    const targetUserId = url.searchParams.get("userId")
    let hasAuthUser = false
    for (const ws of context.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnectionState
      if (state?.type !== "user" || !state.authenticated) continue
      if (targetUserId && state.userId === targetUserId) {
        hasAuthUser = true
      } else {
        invalidateMismatchedUserSocket(context, ws, state, targetUserId, "online-check")
      }
    }
    if (hasAuthUser) {
      return new Response(JSON.stringify({ online: true }), {
        headers: { "Content-Type": "application/json" },
      })
    }
    if (targetUserId) {
      const db = createDb(context.env.DB)
      const { value, stale } = await readOrStale<{ isBotResolved: boolean; online: boolean }>(
        async () => {
          const target = await queries.user.getUserInternal(db, targetUserId)
          if (target?.isBot) {
            const online = await queries.communityMachine.isBotOnline(db, targetUserId)
            return { isBotResolved: true, online }
          }
          return { isBotResolved: false, online: false }
        },
        { isBotResolved: false, online: false },
        { route: "ws-do/check-user-online" },
      )
      if (stale) {
        return new Response(JSON.stringify({ online: false, stale: true }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      if (value.isBotResolved) {
        return new Response(JSON.stringify({ online: value.online }), {
          headers: { "Content-Type": "application/json" },
        })
      }
    }
    return new Response(JSON.stringify({ online: false }), {
      headers: { "Content-Type": "application/json" },
    })
  }

  return null
}

export function acceptUserWebSocket(
  context: WsDurableContext,
  targetUserId?: string,
): Response {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)

  context.ctx.acceptWebSocket(server)

  server.serializeAttachment({
    type: "user",
    userId: "",
    targetUserId,
    authenticated: false,
  } as ConnectionState)

  context.ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair("ping", "pong")
  )

  return new Response(null, { status: 101, webSocket: client })
}

export async function handleWebSocketMessage(
  context: WsDurableContext,
  ws: WebSocket,
  message: string | ArrayBuffer,
  handleCommunityMachineMessage: (parsed: unknown) => Promise<void>,
): Promise<void> {
  if (typeof message !== "string") return

  let parsed: unknown
  try { parsed = JSON.parse(message) } catch { ws.close(1008, "Invalid JSON"); return }

  const state = ws.deserializeAttachment() as ConnectionState

  if (state?.type === "community-machine") {
    await handleCommunityMachineMessage(parsed)
    return
  }

  const msg = parsed as {
    type: string
    token?: string
    machineToken?: string
    daemonId?: string
  }

  if (msg.type === "auth") {
    if (msg.machineToken && msg.daemonId) {
      const authResult = await validateMachineToken(context, msg.machineToken, msg.daemonId)
      if (authResult.kind === "invalid") {
        context.log.warn("daemon websocket auth rejected", { daemonId: msg.daemonId })
        try { ws.send(JSON.stringify({ type: "error", code: "AUTH_REJECTED" })) } catch { }
        ws.close(1008, "Unauthorized")
        return
      }
      if (authResult.kind === "transient") {
        context.log.warn("daemon websocket auth transient failure", { daemonId: msg.daemonId })
        ws.close(1011, "Auth temporarily unavailable")
        return
      }
      ws.serializeAttachment({ type: "daemon", daemonId: msg.daemonId, userId: authResult.userId, authenticated: true } as ConnectionState)
      context.log.info("daemon websocket authenticated", { daemonId: msg.daemonId })
      ws.send(JSON.stringify({ type: "auth.ok" }))

      notifyUserDO(context, authResult.userId, { type: "runtime.status", status: "online", daemonId: msg.daemonId }).catch(() => { })
      return
    }

    if (!msg.token) {
      ws.close(1008, "Unauthorized")
      return
    }
    const identity = await validateToken(context, msg.token)
    if (!identity) {
      context.log.warn("websocket auth failed")
      ws.close(1008, "Unauthorized")
      return
    }
    const { userId, name, discriminator } = identity
    const targetUserId = state?.type === "user" ? state.targetUserId : undefined
    if (!targetUserId || userId !== targetUserId) {
      if (
        state?.type === "user"
        && state.authenticated
        && (!state.targetUserId || state.userId !== state.targetUserId)
      ) {
        ws.serializeAttachment({ ...state, authenticated: false } as ConnectionState)
      }
      context.log.warn("user websocket target mismatch", {
        source: "auth",
        targetUserId: targetUserId ?? null,
        authenticatedUserId: userId,
      })
      ws.close(1008, "Unauthorized")
      return
    }
    const wasOnline = countAuthenticatedUserConnections(context, userId) > 0
    ws.serializeAttachment({
      type: "user",
      userId,
      targetUserId,
      authenticated: true,
      name,
      discriminator,
      ...(state?.type === "user" && state.communityDeliveryProgress
        ? { communityDeliveryProgress: state.communityDeliveryProgress }
        : {}),
    } as ConnectionState)
    context.log.info("websocket authenticated", { userId })
    ws.send(JSON.stringify({ type: "auth.ok" }))
    if (!wasOnline) {
      broadcastPresence(context, userId, true).catch(() => { })
    }
    sendPresenceSnapshot(context, ws, userId).catch(() => { })
    return
  }

  if (!state.authenticated) {
    ws.close(1008, "Not authenticated")
    return
  }

  if (msg.type === "check_daemon_status" && state.type === "user") {
    const daemonId = await getDaemonIdForUser(context, state.userId)
    if (daemonId) {
      try {
        const daemonDoId = context.env.WS_DO.idFromName("daemon:" + daemonId)
        const daemonStub = context.env.WS_DO.get(daemonDoId)
        const resp = await daemonStub.fetch(new Request("http://internal/check-alive"))
        const { alive } = await resp.json() as { alive: boolean }
        if (alive) {
          ws.send(JSON.stringify({ type: "runtime.status", status: "online", daemonId }))
        }
      } catch {
        context.log.debug("check_daemon_status: failed to reach daemon DO", { daemonId })
      }
    }
    return
  }

  if (state.type === "user" && handleClientTypingStart(context, state, parsed)) return
}

export async function handleWebSocketClose(
  context: WsDurableContext,
  ws: WebSocket,
  handleCommunityMachineClose: (state: CommunityMachineConnectionState) => Promise<void>,
): Promise<void> {
  const state = ws.deserializeAttachment() as ConnectionState
  if (state?.type === "daemon" && state.authenticated) {
    context.log.info("daemon websocket closed", { daemonId: state.daemonId })
    notifyUserDO(context, state.userId, { type: "runtime.status", status: "offline", daemonId: state.daemonId }).catch(() => { })
  }
  if (state?.type === "user" && state.authenticated) {
    const remaining = countAuthenticatedUserConnections(context, state.userId) - 1
    if (remaining <= 0) {
      broadcastPresence(context, state.userId, false).catch(() => { })
    }
  }
  if (state?.type === "community-machine" && state.authenticated) {
    await handleCommunityMachineClose(state)
  }
}

export async function handleWebSocketError(
  context: WsDurableContext,
  ws: WebSocket,
  error: unknown,
): Promise<void> {
  context.log.error("websocket error", { err: error instanceof Error ? error : String(error) })
  try { ws.close(1011, "Internal error") } catch { }
}

function broadcast(
  context: WsDurableContext,
  message: string,
  targetUserId: string | null,
): number {
  let sent = 0
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (!state?.authenticated) continue
    if (state.type === "user") {
      if (!targetUserId || state.userId !== targetUserId) {
        invalidateMismatchedUserSocket(context, ws, state, targetUserId, "broadcast")
        continue
      }
    } else if (targetUserId) {
      continue
    }
    try {
      ws.send(message)
      sent++
    } catch { }
  }
  return sent
}

type ValidCommunityBundle = Extract<
  Awaited<ReturnType<typeof readCommunityBrowserEventBundleRequest>>,
  { ok: true }
>

type DeliveryPlan = {
  socketIndex: number
  ws: WebSocket
  state: Extract<ConnectionState, { type: "user" }>
  frames: string[]
  progress: CommunityDeliveryProgress | null
  outcome?: "alreadyEnqueued" | "preflightFailed"
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function deliveryErrorResponse(
  status: 400 | 409,
  value:
    | { operationId: string | null; code: "invalid_request" }
    | { operationId: string; operationDigest: string; code: "operation_digest_conflict" },
): Response {
  return jsonResponse({
    status: status === 400 ? "invalid" : "conflict",
    validated: status !== 400,
    ...value,
  }, status)
}

function socketResult(
  plan: DeliveryPlan,
  outcome: CommunityDeliverySocketResult["outcome"],
  persistedNextFrameIndex: number,
  ambiguousClosed = false,
): CommunityDeliverySocketResult {
  return {
    socketIndex: plan.socketIndex,
    outcome,
    frameCount: 1,
    persistedNextFrameIndex,
    ambiguousClosed,
  }
}

function safeCloseAmbiguousSocket(ws: WebSocket): void {
  try { ws.close(1011, "Delivery state unavailable") } catch { }
}

function deliverCommunityBundle(
  context: WsDurableContext,
  bundle: ValidCommunityBundle,
  targetUserId: string,
): Response {
  const encodedBatch = encodePreparedCommunityBrowserEventBatch({
    operationId: bundle.operationId,
    operationDigest: bundle.operationDigest,
    prepared: bundle.prepared,
  })
  const targetSockets: Array<{
    ws: WebSocket
    state: Extract<ConnectionState, { type: "user" }>
  }> = []
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (!state?.authenticated) continue
    if (state.type !== "user" || state.userId !== targetUserId) {
      if (state.type === "user") {
        invalidateMismatchedUserSocket(context, ws, state, targetUserId, "broadcast")
      }
      continue
    }
    targetSockets.push({ ws, state })
  }

  const plans: DeliveryPlan[] = targetSockets.map(({ ws, state }, socketIndex) => ({
    socketIndex,
    ws,
    state,
    frames: encodedBatch.ok ? [encodedBatch.body] : [],
    progress: null,
  }))

  if (!encodedBatch.ok) {
    context.log.error("community_delivery_batch_encoder_invariant_failed", {
      operationId: bundle.operationId,
      reason: encodedBatch.reason,
      ...(encodedBatch.byteLength === undefined ? {} : { byteLength: encodedBatch.byteLength }),
      eventCount: bundle.eventCount,
      matched: plans.length,
    })
    const results = plans.map((plan) => socketResult(plan, "preflightFailed", 0))
    return jsonResponse(createCommunityDeliveryReceipt({
      status: "incomplete",
      operationId: bundle.operationId,
      operationDigest: bundle.operationDigest,
      eventCount: bundle.eventCount,
      results,
    }), 503)
  }

  let hasConflict = false
  for (const plan of plans) {
    const decoded = readCommunityDeliveryProgress(plan.state)
    if (!decoded.ok) {
      plan.outcome = "preflightFailed"
      continue
    }
    const progress = decoded.entries.find((entry) => entry.operationId === bundle.operationId) ?? null
    plan.progress = progress
    if (progress?.operationDigest !== undefined && progress.operationDigest !== bundle.operationDigest) {
      hasConflict = true
      continue
    }
    if (progress && progress.frameCount !== plan.frames.length) {
      plan.outcome = "preflightFailed"
      continue
    }
    if (progress?.nextFrameIndex === plan.frames.length) {
      plan.outcome = "alreadyEnqueued"
      continue
    }
    let candidateState = plan.state
    const startIndex = progress?.nextFrameIndex ?? 0
    for (let nextFrameIndex = startIndex + 1; nextFrameIndex <= plan.frames.length; nextFrameIndex += 1) {
      try {
        candidateState = withCommunityDeliveryProgress(candidateState, {
          operationId: bundle.operationId,
          operationDigest: bundle.operationDigest,
          nextFrameIndex,
          frameCount: plan.frames.length,
        })
      } catch {
        plan.outcome = "preflightFailed"
        break
      }
      if (!preflightCommunityConnectionState(candidateState).ok) {
        plan.outcome = "preflightFailed"
        break
      }
    }
  }

  if (hasConflict) {
    context.log.warn("community_delivery_operation_digest_conflict", {
      operationId: bundle.operationId,
      eventCount: bundle.eventCount,
      matched: plans.length,
    })
    return deliveryErrorResponse(409, {
      operationId: bundle.operationId,
      operationDigest: bundle.operationDigest,
      code: "operation_digest_conflict",
    })
  }

  if (plans.some((plan) => plan.outcome === "preflightFailed")) {
    const results = plans.map((plan) => {
      const persisted = plan.progress?.nextFrameIndex ?? 0
      if (plan.outcome === "alreadyEnqueued") return socketResult(plan, "alreadyEnqueued", persisted)
      return socketResult(
        plan,
        plan.outcome === "preflightFailed" ? "preflightFailed" : "notAttempted",
        persisted,
      )
    })
    return jsonResponse(createCommunityDeliveryReceipt({
      status: "incomplete",
      operationId: bundle.operationId,
      operationDigest: bundle.operationDigest,
      eventCount: bundle.eventCount,
      results,
    }), 503)
  }

  const results: CommunityDeliverySocketResult[] = []
  for (const plan of plans) {
    let persisted = plan.progress?.nextFrameIndex ?? 0
    if (plan.outcome === "alreadyEnqueued") {
      results.push(socketResult(plan, "alreadyEnqueued", persisted))
      continue
    }
    let state = plan.state
    let terminal: CommunityDeliverySocketResult | null = null
    for (let frameIndex = persisted; frameIndex < plan.frames.length; frameIndex += 1) {
      try {
        plan.ws.send(plan.frames[frameIndex])
      } catch {
        terminal = socketResult(plan, persisted > 0 ? "partial" : "failed", persisted)
        break
      }
      const nextFrameIndex = frameIndex + 1
      let nextState: typeof state
      try {
        nextState = withCommunityDeliveryProgress(state, {
          operationId: bundle.operationId,
          operationDigest: bundle.operationDigest,
          nextFrameIndex,
          frameCount: plan.frames.length,
        })
        plan.ws.serializeAttachment(nextState)
      } catch {
        safeCloseAmbiguousSocket(plan.ws)
        terminal = socketResult(plan, persisted > 0 ? "partial" : "failed", persisted, true)
        break
      }
      state = nextState
      persisted = nextFrameIndex
    }
    results.push(terminal ?? socketResult(plan, "enqueued", persisted))
  }

  const complete = results.every((result) =>
    result.outcome === "enqueued" || result.outcome === "alreadyEnqueued")
  return jsonResponse(createCommunityDeliveryReceipt({
    status: complete ? "complete" : "incomplete",
    operationId: bundle.operationId,
    operationDigest: bundle.operationDigest,
    eventCount: bundle.eventCount,
    results,
  }), complete ? 200 : 503)
}

function invalidateMismatchedUserSocket(
  context: WsDurableContext,
  ws: WebSocket,
  state: Extract<ConnectionState, { type: "user" }>,
  targetUserId: string | null,
  source: "broadcast" | "online-check",
): void {
  ws.serializeAttachment({ ...state, authenticated: false } as ConnectionState)
  context.log.warn("historical user websocket target mismatch", {
    source,
    targetUserId,
    authenticatedUserId: state.userId,
  })
  try {
    ws.close(1008, "Unauthorized")
  } catch { }
}

function countAuthenticatedUserConnections(context: WsDurableContext, userId: string): number {
  let count = 0
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type === "user" && state.authenticated && state.userId === userId) {
      count++
    }
  }
  return count
}

async function getDaemonIdForUser(context: WsDurableContext, userId: string): Promise<string | null> {
  const db = createDb(context.env.DB)
  const token = await queries.machineToken.getLatestTokenForUser(db, userId)
  return token?.hostname || null
}

async function validateToken(
  context: WsDurableContext,
  token: string,
): Promise<{ userId: string; name: string; discriminator: string } | null> {
  const db = createDb(context.env.DB)
  return withD1Retry(
    () => queries.session.getValidSessionWithIdentity(db, token),
    { route: "ws-do:user-auth-session" },
  )
}

async function validateMachineToken(
  context: WsDurableContext,
  token: string,
  daemonId: string,
): Promise<
  | { kind: "valid"; userId: string }
  | { kind: "invalid" }
  | { kind: "transient" }
> {
  if (!token.startsWith("al_")) return { kind: "invalid" }
  try {
    const db = createDb(context.env.DB)
    const mt = await queries.machineToken.getMachineTokenByToken(db, token)
    if (!mt || mt.status !== "active" || !mt.workspaceId) return { kind: "invalid" }
    const machine = await queries.machine.getMachineByDaemon(db, daemonId, mt.workspaceId)
    if (!machine) return { kind: "invalid" }
    return { kind: "valid", userId: mt.userId }
  } catch (err) {
    context.log.warn("daemon websocket auth lookup threw", { err: String(err) })
    return { kind: "transient" }
  }
}
