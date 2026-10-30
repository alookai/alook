import {
  BUSINESS_SCHEMA_VERSION,
  type CommunityContract,
  createDb,
  encodeCommunityBrowserEventBatchForContract,
  encodeCommunityBrowserEvent,
  isUserWsConnectionPing,
  isValidCommunityUserTarget,
  queries,
  readOrStale,
  withD1Retry,
} from "@alook/shared"
import {
  createCommunityDeliveryReceipt,
  type CommunityDeliverySocketResult,
  type CommunityDeliveryCancellation,
} from "../community-delivery-receipt"
import type {
  CommunityMachineConnectionState,
  ConnectionState,
  WsDurableContext,
} from "./internal"
import {
  broadcastPresence,
  handleClientTypingStart,
  handleClientTypingStop,
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
import { canDeliverCommunityContent } from "../community-content-access"
import { handleUserAgentInterrupt } from "./agent-interrupt"

const USER_SESSION_CHECK_INTERVAL_MS = 60_000

async function refreshUserSession(context: WsDurableContext, ws: WebSocket): Promise<void> {
  const state = ws.deserializeAttachment() as ConnectionState
  if (state?.type !== "user" || !state.authenticated) return
  if (!isCurrentBusinessSocket(ws, state) || (state.sessionValidUntil ?? 0) > Date.now()) return
  try {
    const session = state.sessionId
      ? await queries.session.getValidSessionByIdForUser(createDb(context.env.DB), state.sessionId, state.userId)
      : null
    if (session) {
      const current = ws.deserializeAttachment() as ConnectionState
      if (current?.type === "user" && current.sessionId === state.sessionId && current.authenticated) {
        ws.serializeAttachment({ ...current, sessionValidUntil: Math.min(Date.now() + USER_SESSION_CHECK_INTERVAL_MS, Date.parse(session.expiresAt)) })
      }
      return
    }
  } catch {
    context.log.warn("user_session_refresh_failed", { userId: state.userId })
  }
  const current = ws.deserializeAttachment() as ConnectionState
  if (current?.type !== "user" || current.sessionId !== state.sessionId) return
  ws.serializeAttachment({ ...current, authenticated: false })
  ws.close(1008, "Session expired or revoked")
}

export async function handleUserFetch(
  context: WsDurableContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (["/community-broadcast-bundle", "/community-broadcast", "/broadcast", "/check-user-online"].includes(url.pathname)) {
    for (const ws of context.ctx.getWebSockets()) await refreshUserSession(context, ws)
  }
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
    if (!hasAuthenticatedTargetSocket(context, targetUserId)) {
      return deliverCommunityBundle(context, bundle, targetUserId)
    }
    try {
      if (!await canDeliverCommunityContent(createDb(context.env.DB), targetUserId, bundle.prepared.events)) {
        return jsonResponse({
          status: "cancelled",
          reason: "access-revoked",
          targetUserId,
          operationId: bundle.operationId,
          operationDigest: bundle.operationDigest,
          eventCount: bundle.eventCount,
        } satisfies CommunityDeliveryCancellation, 200)
      }
    } catch (error) {
      context.log.warn("community_delivery_access_failed", {
        targetUserId,
        error: String(error),
        cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
      })
      return jsonResponse({ operationId: bundle.operationId, error: "access_check_failed" }, 503)
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
    if (!hasAuthenticatedTargetSocket(context, targetUserId)) {
      return jsonResponse({ sent: broadcastCommunity(context, event.event, targetUserId, event.contract) })
    }
    try {
      if (!await canDeliverCommunityContent(createDb(context.env.DB), targetUserId, [event.event])) {
        context.log.info("community_content_access_denied", { targetUserId, type: event.event.type })
        return jsonResponse({ sent: 0 }, 200)
      }
    } catch (error) {
      context.log.warn("community_content_access_failed", {
        targetUserId,
        error: String(error),
        cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
      })
      return jsonResponse({ error: "access_check_failed" }, 503)
    }
    const sent = broadcastCommunity(context, event.event, targetUserId, event.contract)
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

  const originalState = ws.deserializeAttachment() as ConnectionState
  if (originalState?.type === "user" && originalState.authenticated && !isCurrentBusinessSocket(ws, originalState)) return
  await refreshUserSession(context, ws)

  const state = ws.deserializeAttachment() as ConnectionState

  const controlType = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).type
    : undefined
  if (controlType === "connection.ping" || controlType === "connection.pong") {
    if (!state?.authenticated) {
      ws.close(1008, "Not authenticated")
      return
    }
    if (state.type === "user" && isUserWsConnectionPing(parsed)) {
      ws.send(JSON.stringify({ type: "connection.pong", nonce: parsed.nonce }))
    }
    return
  }

  if (state?.type === "community-machine") {
    await handleCommunityMachineMessage(parsed)
    return
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== "string") return

  const msg = parsed as {
    type: string
    token?: string
    communityContract?: unknown
  }

  if (msg.type === "auth") {
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
    if (msg.communityContract !== BUSINESS_SCHEMA_VERSION
      || (state?.type === "user" && state.authenticated && state.communityContract !== BUSINESS_SCHEMA_VERSION)) {
      ws.send(JSON.stringify({ type: "auth.error", error: "Unsupported community contract", communityContract: BUSINESS_SCHEMA_VERSION }))
      ws.close(1008, "Unsupported community contract")
      return
    }
    const communityContract = BUSINESS_SCHEMA_VERSION
    ws.serializeAttachment({
      type: "user",
      userId,
      targetUserId,
      authenticated: true,
      sessionId: identity.sessionId,
      sessionValidUntil: Math.min(Date.now() + USER_SESSION_CHECK_INTERVAL_MS, Date.parse(identity.expiresAt)),
      name,
      discriminator,
      communityContract,
      ...(state?.type === "user" && state.communityDeliveryProgress
        ? { communityDeliveryProgress: state.communityDeliveryProgress }
        : {}),
    } as ConnectionState)
    context.log.info("websocket authenticated", { userId })
    ws.send(JSON.stringify({ type: "auth.ok", communityContract }))
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

  if (state.type === "user" && !isCurrentBusinessSocket(ws, state)) return
  if (state.type === "user" && msg.type.startsWith("community:") && (parsed as Record<string, unknown>).schemaVersion !== BUSINESS_SCHEMA_VERSION) {
    ws.close(1008, "Unsupported community contract")
    return
  }
  if (state.type === "user" && await handleUserAgentInterrupt(context, state, parsed)) return
  if (state.type === "user") {
    const typingStart = handleClientTypingStart(context, state, parsed)
    if (typingStart) {
      await typingStart
      return
    }
    const typingStop = handleClientTypingStop(context, state, parsed)
    if (typingStop) {
      await typingStop
      return
    }
  }
}

export async function handleWebSocketClose(
  context: WsDurableContext,
  ws: WebSocket,
  handleCommunityMachineClose: (state: CommunityMachineConnectionState) => Promise<void>,
): Promise<void> {
  const state = ws.deserializeAttachment() as ConnectionState
  if (state?.type === "user" && state.authenticated) {
    if (!hasOtherAuthenticatedUserConnection(context, ws, state.userId)) {
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

function hasAuthenticatedTargetSocket(context: WsDurableContext, targetUserId: string): boolean {
  return context.ctx.getWebSockets().some((ws) => {
    const state = ws.deserializeAttachment() as ConnectionState
    return state?.type === "user" && state.authenticated && state.userId === targetUserId
  })
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

function broadcastCommunity(context: WsDurableContext, event: import("@alook/shared").CommunityWsEvent, targetUserId: string, sourceContract: CommunityContract = BUSINESS_SCHEMA_VERSION) {
  const encoded = encodeCommunityBrowserEvent(event, sourceContract)
  if (!encoded.ok) return 0
  let sent = 0
  for (const ws of context.ctx.getWebSockets()) {
    const state = ws.deserializeAttachment() as ConnectionState
    if (state?.type !== "user" || !state.authenticated || state.userId !== targetUserId) continue
    if (!isCurrentBusinessSocket(ws, state)) continue
    try { ws.send(encoded.body); sent++ } catch { }
  }
  return sent
}

function isCurrentBusinessSocket(ws: WebSocket, state: Extract<ConnectionState, { type: "user" }>): boolean {
  if (state.communityContract === BUSINESS_SCHEMA_VERSION) return true
  ws.serializeAttachment({ ...state, authenticated: false })
  try {
    ws.send(JSON.stringify({ type: "auth.error", error: "Unsupported community contract", communityContract: BUSINESS_SCHEMA_VERSION }))
    ws.close(1008, "Unsupported community contract")
  } catch { }
  return false
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

async function deliverCommunityBundle(
  context: WsDurableContext,
  bundle: ValidCommunityBundle,
  targetUserId: string,
): Promise<Response> {
  const encodedBatch = await encodeCommunityBrowserEventBatchForContract({
    operationId: bundle.operationId, prepared: bundle.prepared, contract: BUSINESS_SCHEMA_VERSION,
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
    if (isCurrentBusinessSocket(ws, state)) targetSockets.push({ ws, state })
  }

  const plans: DeliveryPlan[] = targetSockets.map(({ ws, state }, socketIndex) => ({
    socketIndex, ws, state, frames: encodedBatch.ok ? [encodedBatch.body] : [], progress: null,
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
    if (plan.frames.length === 0) { plan.outcome = "preflightFailed"; continue }
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

function hasOtherAuthenticatedUserConnection(
  context: WsDurableContext,
  closingSocket: WebSocket,
  userId: string,
): boolean {
  return context.ctx.getWebSockets().some((ws) => {
    if (ws === closingSocket) return false
    const state = ws.deserializeAttachment() as ConnectionState
    return state?.type === "user" && state.authenticated && state.userId === userId
  })
}

async function validateToken(
  context: WsDurableContext,
  token: string,
): ReturnType<typeof queries.session.getValidSessionWithIdentity> {
  const db = createDb(context.env.DB)
  return withD1Retry(
    () => queries.session.getValidSessionWithIdentity(db, token),
    { route: "ws-do:user-auth-session" },
  )
}
