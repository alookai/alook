"use client"
import { requestBusinessSchemaUpdate } from "@/lib/business-schema-lifecycle"
import { currentPageObservation, startPageOperation, finishPageOperation, pageOperationAttributes, runPageOperation, type PageOperation } from "@/lib/observability/context"
import { emitTelemetry, isTelemetryEligible, telemetryGeneration } from "@/lib/observability/telemetry"
import { useEffect, useRef, useCallback } from "react"
import {
  COMMUNITY_CONTRACT_VERSION,
  type CommunityContract,
  communityBrowserEventBatchType,
  COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES,
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  isCommunityBrowserEventBatchCandidate,
  isCommunityEventCandidate,
  isCommunityEventType,
  isUserWsConnectionPong,
  type WsMessage,
} from "@alook/shared"
import {
  type CommunityWsFrameDropReason,
  type CommunityWsLifecycleStageResult,
  type CommunityWsLifecycleRecoveryTrigger,
} from "@/lib/community/ws-connection-types"
import { isLocalServiceEnvironment, WS_DO_PORT_DEFAULT } from "@/lib/utils"
import { websocketUrl } from "@/lib/websocket-url"
import { authClient } from "@/lib/auth-client"
import { listenNativeWindowLifecycle } from "@/lib/native-window-lifecycle"

const useLocalServices = isLocalServiceEnvironment()
const WS_RECONNECT_INIT = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_DELAY_MS) || 1000
const WS_RECONNECT_MAX = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_MAX_DELAY_MS) || 30_000
const WS_TOKEN_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_WS_TOKEN_TIMEOUT_MS) || 10_000
export const WS_CONNECTION_VALIDATION_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_WS_CONNECT_TIMEOUT_MS) || 10_000
export const WS_FOREGROUND_SENTINEL_INTERVAL_MS = 10_000
export const WS_FOREGROUND_SUSPENSION_GAP_MS = 30_000

type PendingConnectionValidation = {
  ws: WebSocket
  generation: number
  nonce: string
  timeout: ReturnType<typeof setTimeout>
}

type PendingTokenAttempt = {
  controller: AbortController
  generation: number
  startedAt: number
  reported: boolean
  observationGeneration: number
  operation?: PageOperation
}

type CredentialRetry = {
  rejectedSessionId: string | null
  refreshUsed: boolean
  stopped: boolean
  refetchUsed: boolean
}

function currentSdkWsSession(viewerUserId: string | null | undefined) {
  if (!viewerUserId) return
  const current = authClient.$store.atoms.session.get()
  const data = current.data
  const session = data?.session
  if (current.isPending || current.error || data?.user?.id !== viewerUserId
    || !session || session.userId !== viewerUserId || !session.id || !session.token) return
  const expiresAt = session.expiresAt
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= Date.now()) return
  return data
}

function isCurrentWsAccount(viewerUserId: string | null | undefined) {
  if (viewerUserId === undefined) return true
  if (!viewerUserId) return false
  const current = authClient.$store.atoms.session.get()
  return current.isPending || Boolean(current.error) || current.data?.user?.id === viewerUserId
}

function isWsCredentialRejection(event?: Pick<CloseEvent, "code" | "reason">) {
  return event?.code === 1008 && event.reason === "Unauthorized"
}

function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

function boundedDurationMs(startedAt: number): number {
  return Math.min(Math.max(0, Date.now() - startedAt), 600_000)
}

function normalizedCloseCode(code: number | undefined): number {
  if (code === undefined || !Number.isInteger(code) || code < 0 || code > 4999) return 0
  return code
}

export type WsMessageIncoming = WsMessage & { [key: string]: unknown }

export type UserWsConnectionPhase = "authenticated" | "reconnecting" | "suspended"

export type UseUserWsOptions = {
  viewerUserId?: string | null
  communityContract?: CommunityContract
  onReconnect?: (info: { reconnectDurationMs: number }) => void | Promise<void>
  onDisconnect?: () => void | Promise<void>
  onAuthenticated?: () => void | Promise<void>
  onForeground?: () => void | Promise<void>
  onConnectionStateChange?: (phase: UserWsConnectionPhase) => void | Promise<void>
}

function runLifecycleCallback(
  name: "authenticated" | "connection-state" | "disconnect" | "foreground" | "reconnect",
  callback: (() => void | Promise<void>) | undefined,
) {
  if (!callback) return
  try {
    const result = callback()
    if (result && typeof result.then === "function") {
      void result.catch(() => {
        console.warn("[ws] lifecycle callback rejected", { callback: name })
      })
    }
  } catch {
    console.warn("[ws] lifecycle callback threw", { callback: name })
  }
}

function reportDroppedFrame(
  reason: CommunityWsFrameDropReason,
  value?: Record<string, unknown>,
  byteCount?: number,
) {
  const rawType = value?.type
  const type = isCommunityEventType(rawType) ? rawType : "unknown"
  const metadata = {
    reason,
    type,
    ...(byteCount === undefined ? {} : { byteCount }),
  }
  console.warn("[ws] frame dropped", { event: "community_ws_frame_dropped", ...metadata })

}

export function useUserWs(
  onMessage: (msg: WsMessageIncoming, assertCurrent?: () => void, communityContract?: CommunityContract) => void | Promise<void>,
  options?: UseUserWsOptions,
): { send: (msg: object) => void; reconnectNow: () => void } {
  const viewerUserId = options?.viewerUserId
  const previousViewerRef = useRef(viewerUserId)
  const wsPortRef = useRef(WS_DO_PORT_DEFAULT)
  const credentialRetryRef = useRef<CredentialRetry>({
    rejectedSessionId: null, refreshUsed: false, stopped: false, refetchUsed: false,
  })
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(WS_RECONNECT_INIT)
  const reconnectAttemptRef = useRef(0)
  const onMessageRef = useRef(onMessage)
  const requestedCommunityContractRef = useRef(options?.communityContract ?? COMMUNITY_CONTRACT_VERSION)
  const onReconnectRef = useRef(options?.onReconnect)
  const onDisconnectRef = useRef(options?.onDisconnect)
  const onAuthenticatedRef = useRef(options?.onAuthenticated)
  const onForegroundRef = useRef(options?.onForeground)
  const onConnectionStateChangeRef = useRef(options?.onConnectionStateChange)
  const lastConnectionPhaseRef = useRef<UserWsConnectionPhase | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingTokenRef = useRef<PendingTokenAttempt | null>(null)
  const tokenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectStartedAtRef = useRef(0)
  const hasAuthenticatedBeforeRef = useRef(false)
  const authenticatedGenerationRef = useRef<number | null>(null)
  const disconnectedAtRef = useRef<number | null>(null)
  const lastMessageAtRef = useRef(0)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const livenessIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const connectionGenerationRef = useRef(0)
  const connectionValidationRef = useRef<PendingConnectionValidation | null>(null)
  const connectionValidationNeededRef = useRef(isPageHidden())
  const frozenRef = useRef(false)
  const nativeSuspendedRef = useRef(false)
  const isBackground = useCallback(() => isPageHidden() || nativeSuspendedRef.current, [])
  const sentinelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSentinelTickAtRef = useRef(0)
  const offlineRef = useRef(isBrowserOffline())
  const offlineCleanupAppliedRef = useRef(false)
  const localCloseSocketsRef = useRef(new WeakSet<WebSocket>())
  const reportedCloseSocketsRef = useRef(new WeakSet<WebSocket>())
  const isOffline = useCallback(() => {
    if (offlineRef.current) return true
    if (!isBrowserOffline()) return false
    offlineRef.current = true
    return true
  }, [])

  useEffect(() => {
    onMessageRef.current = onMessage
    requestedCommunityContractRef.current = options?.communityContract ?? COMMUNITY_CONTRACT_VERSION
  }, [onMessage, options?.communityContract])

  useEffect(() => {
    onReconnectRef.current = options?.onReconnect
  }, [options?.onReconnect])

  useEffect(() => {
    onDisconnectRef.current = options?.onDisconnect
    onAuthenticatedRef.current = options?.onAuthenticated
    onForegroundRef.current = options?.onForeground
    onConnectionStateChangeRef.current = options?.onConnectionStateChange
  }, [
    options?.onAuthenticated,
    options?.onForeground,
    options?.onConnectionStateChange,
    options?.onDisconnect,
  ])

  const observedSockets = useRef(new WeakMap<WebSocket, { generation: number; start: number; operation?: PageOperation }>())
  const connectRef = useRef<(() => Promise<void>) | null>(null)

  const publishConnectionPhase = useCallback((phase: UserWsConnectionPhase) => {
    if (lastConnectionPhaseRef.current === phase) return
    lastConnectionPhaseRef.current = phase
    const observed = wsRef.current ? observedSockets.current.get(wsRef.current) : undefined
    if (phase === "authenticated" && observed?.generation === telemetryGeneration()) {
      finishPageOperation(observed.operation, "success")
      emitTelemetry("ws.ready", { ...pageOperationAttributes(observed.operation), phase: "auth", outcome: "success", duration_ms: performance.now() - observed.start })
    }
    runLifecycleCallback("connection-state", () =>
      onConnectionStateChangeRef.current?.(phase))
  }, [])

  const ownsConnection = useCallback((ws: WebSocket, generation: number) => (
    ws === wsRef.current && generation === connectionGenerationRef.current
    && isCurrentWsAccount(viewerUserId)
  ), [viewerUserId])

  const ownsAuthenticatedConnection = useCallback((ws: WebSocket, generation: number) => (
    ownsConnection(ws, generation)
    && authenticatedGenerationRef.current === generation
    && ws.readyState === WebSocket.OPEN
  ), [ownsConnection])

  const clearConnectionValidation = useCallback(() => {
    const pending = connectionValidationRef.current
    connectionValidationRef.current = null
    if (pending) clearTimeout(pending.timeout)

  }, [])

  const reportTokenAttempt = useCallback((
    attempt: PendingTokenAttempt,
    result: CommunityWsLifecycleStageResult,
  ) => {
    if (attempt.reported) return
    attempt.reported = true
    finishPageOperation(attempt.operation, result === "success" ? "success" : result === "aborted" ? "cancelled" : result === "timeout" ? "timeout" : "error")
    if (attempt.observationGeneration === telemetryGeneration()) emitTelemetry("ws.connect", { ...pageOperationAttributes(attempt.operation), phase: "token", outcome: result === "success" ? "success" : result === "aborted" ? "cancelled" : result === "timeout" ? "timeout" : "error", duration_ms: attempt.operation ? performance.now() - attempt.operation.start : boundedDurationMs(attempt.startedAt) })

  }, [])

  const abortPendingToken = useCallback(() => {
    const attempt = pendingTokenRef.current
    pendingTokenRef.current = null
    if (attempt) {
      reportTokenAttempt(attempt, "aborted")
      attempt.controller.abort()
    }
    if (tokenTimeoutRef.current !== null) {
      clearTimeout(tokenTimeoutRef.current)
      tokenTimeoutRef.current = null
    }
  }, [reportTokenAttempt])

  const closeSocket = useCallback((ws: WebSocket) => {
    if (
      !localCloseSocketsRef.current.has(ws)
      && ws.readyState !== WebSocket.CLOSING
      && ws.readyState !== WebSocket.CLOSED
    ) {
      localCloseSocketsRef.current.add(ws)
    }
    ws.close()
  }, [])

  const reportSocketClose = useCallback((
    ws: WebSocket,
    event?: Pick<CloseEvent, "code" | "wasClean">,
  ) => {
    const localInitiator = localCloseSocketsRef.current.has(ws)
    localCloseSocketsRef.current.delete(ws)
    const code = normalizedCloseCode(event?.code)
    if (!reportedCloseSocketsRef.current.has(ws)) {
      reportedCloseSocketsRef.current.add(ws)
      const observed = observedSockets.current.get(ws)
      finishPageOperation(observed?.operation, localInitiator ? "cancelled" : "error")
      if (observed?.generation === telemetryGeneration()) emitTelemetry("ws.close", { ...pageOperationAttributes(observed.operation), phase: "transport", outcome: "observed", duration_ms: performance.now() - observed.start, status: code })

    }
  }, [])

  const stopHeartbeat = useCallback(() => {
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
    if (livenessIntervalRef.current) { clearInterval(livenessIntervalRef.current); livenessIntervalRef.current = null }
  }, [])

  const retireSocket = useCallback((
    reportDisconnect: boolean,
  ) => {
    const ws = wsRef.current
    const disconnected = reportDisconnect && authenticatedGenerationRef.current !== null
    wsRef.current = null
    clearConnectionValidation()
    if (disconnected) {
      authenticatedGenerationRef.current = null
      disconnectedAtRef.current ??= Date.now()
    }
    stopHeartbeat()
    if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    if (ws) { finishPageOperation(observedSockets.current.get(ws)?.operation, "cancelled"); closeSocket(ws) }
    if (disconnected) runLifecycleCallback("disconnect", onDisconnectRef.current)
  }, [clearConnectionValidation, closeSocket, stopHeartbeat])

  const stopCredentialRetry = useCallback(() => {
    const retry = credentialRetryRef.current
    retry.stopped = true
    retireSocket(true)
    if (viewerUserId === undefined || retry.refetchUsed) return
    retry.refetchUsed = true
    void authClient.$store.atoms.session.get().refetch({ query: { disableCookieCache: true } }).catch(() => {
      console.warn("[ws] session refetch failed")
    })
  }, [retireSocket, viewerUserId])

  const scheduleReconnect = useCallback((generation: number) => {
    if (generation !== connectionGenerationRef.current) return
    if (credentialRetryRef.current.stopped || !isCurrentWsAccount(viewerUserId)) return
    if (isBackground() || isOffline() || frozenRef.current) return
    const windowMs = Math.min(reconnectDelay.current, WS_RECONNECT_MAX)
    const delayMs = Math.floor(Math.random() * windowMs)
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    reconnectDelay.current = Math.min(windowMs * 2, WS_RECONNECT_MAX)
    emitTelemetry("ws.reconnect", { phase: "transport", attempt, duration_ms: delayMs, outcome: "observed" })

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      if (
        generation !== connectionGenerationRef.current
        || isBackground()
        || isOffline()
        || frozenRef.current
      ) return
      void connectRef.current?.()
    }, delayMs)
  }, [isBackground, isOffline, viewerUserId])

  const recoverTimedOutConnection = useCallback((
    ws: WebSocket,
    generation: number,
  ) => {
    if (!ownsConnection(ws, generation)) return
    retireSocket(true)
    if (generation !== connectionGenerationRef.current || !isCurrentWsAccount(viewerUserId)) return
    publishConnectionPhase(isBackground() || frozenRef.current ? "suspended" : "reconnecting")
    scheduleReconnect(generation)
  }, [isBackground, ownsConnection, publishConnectionPhase, retireSocket, scheduleReconnect, viewerUserId])

  const startHeartbeat = useCallback((ws: WebSocket, generation: number) => {
    stopHeartbeat()
    if (
      isBackground()
      || isOffline()
      || frozenRef.current
      || !ownsAuthenticatedConnection(ws, generation)
    ) return
    lastMessageAtRef.current = Date.now()
    pingIntervalRef.current = setInterval(() => {
      if (
        !isOffline()
        && !isBackground()
        && !frozenRef.current
        && ownsAuthenticatedConnection(ws, generation)
      ) ws.send("ping")
    }, 25_000)
    livenessIntervalRef.current = setInterval(() => {
      if (
        !isOffline()
        && !isBackground()
        && !frozenRef.current
        && ownsAuthenticatedConnection(ws, generation)
        && Date.now() - lastMessageAtRef.current > 30_000
      ) recoverTimedOutConnection(ws, generation)
    }, 5_000)
  }, [isBackground, isOffline, ownsAuthenticatedConnection, recoverTimedOutConnection, stopHeartbeat])

  const failConnectionValidation = useCallback((
    ws: WebSocket,
    generation: number,
    nonce: string,
  ) => {
    const pending = connectionValidationRef.current
    if (
      !pending
      || pending.ws !== ws
      || pending.generation !== generation
      || pending.nonce !== nonce
      || ws !== wsRef.current
      || generation !== connectionGenerationRef.current
    ) return
    recoverTimedOutConnection(ws, generation)
  }, [recoverTimedOutConnection])

  const validateCurrentConnection = useCallback((ws: WebSocket, generation: number) => {
    if (
      isOffline()
      || isBackground()
      || frozenRef.current
      || !ownsAuthenticatedConnection(ws, generation)
    ) return
    const current = connectionValidationRef.current
    if (
      current?.ws === ws
      && current.generation === generation
      && ws === wsRef.current
      && generation === connectionGenerationRef.current
    ) return
    clearConnectionValidation()
    stopHeartbeat()
    const nonce = crypto.randomUUID()
    const pending: PendingConnectionValidation = {
      ws,
      generation,
      nonce,
      timeout: setTimeout(() => {
        failConnectionValidation(ws, generation, nonce)
      }, WS_CONNECTION_VALIDATION_TIMEOUT_MS),
    }
    connectionValidationRef.current = pending
    try {
      ws.send(JSON.stringify({ type: "connection.ping", nonce }))
    } catch {
      failConnectionValidation(ws, generation, nonce)
    }
  }, [
    clearConnectionValidation,
    failConnectionValidation,
    isBackground,
    isOffline,
    ownsAuthenticatedConnection,
    stopHeartbeat,
  ])

  const connect = useCallback(async () => {
    if (credentialRetryRef.current.stopped || !isCurrentWsAccount(viewerUserId)) return
    if (isBackground() || isOffline() || frozenRef.current) {
      publishConnectionPhase(
        isBackground() || frozenRef.current ? "suspended" : "reconnecting",
      )
      return
    }
    if (pendingTokenRef.current) return
    const previousGeneration = connectionGenerationRef.current
    publishConnectionPhase("reconnecting")
    if (
      pendingTokenRef.current
      || previousGeneration !== connectionGenerationRef.current
      || isBackground()
      || isOffline()
      || frozenRef.current
      || !isCurrentWsAccount(viewerUserId)
    ) return
    const generation = previousGeneration + 1
    connectionGenerationRef.current = generation
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const observationGeneration = telemetryGeneration(), observationPage = currentPageObservation()
    const currentSession = currentSdkWsSession(viewerUserId)
    const sdkSession = hasAuthenticatedBeforeRef.current
      && currentSession?.session.id !== credentialRetryRef.current.rejectedSessionId
      ? currentSession : undefined
    let userId: string
    let authToken: string
    let wsPort = wsPortRef.current
    if (sdkSession) {
      userId = sdkSession.user.id
      authToken = sdkSession.session.token
    } else {
      const tokenController = new AbortController()
      const tokenAttempt: PendingTokenAttempt = {
        controller: tokenController,
        generation,
        startedAt: Date.now(),
        reported: false,
        observationGeneration,
        operation: startPageOperation("ws.connect", { phase: "token" }, observationPage),
      }
      if (isTelemetryEligible()) emitTelemetry("ws.connect", { ...pageOperationAttributes(tokenAttempt.operation), phase: "token", start_ms: performance.now(), outcome: "observed" })
      pendingTokenRef.current = tokenAttempt
      let tokenTimedOut = false
      tokenTimeoutRef.current = setTimeout(() => {
        if (pendingTokenRef.current !== tokenAttempt) return
        tokenTimedOut = true
        pendingTokenRef.current = null
        tokenTimeoutRef.current = null
        reportTokenAttempt(tokenAttempt, "timeout")

        tokenController.abort()
        scheduleReconnect(generation)
      }, WS_TOKEN_TIMEOUT_MS)
      const retry = credentialRetryRef.current
      const refresh = Boolean(retry.rejectedSessionId) && !retry.refreshUsed
      if (refresh) retry.refreshUsed = true
      try {
        const res = await runPageOperation(tokenAttempt.operation, () => fetch(refresh ? "/api/ws/token?refresh=1" : "/api/ws/token", { signal: tokenController.signal }))
        if (
          pendingTokenRef.current !== tokenAttempt
          || generation !== connectionGenerationRef.current
          || isOffline()
          || !isCurrentWsAccount(viewerUserId)
        ) return
        if (!res.ok) {
          reportTokenAttempt(tokenAttempt, "failure")

          console.warn("[ws] token fetch failed:", res.status)
          if (viewerUserId !== undefined && (res.status === 401 || res.status === 403)) stopCredentialRetry()
          else scheduleReconnect(generation)
          return
        }
        const body = await res.json() as { userId: string; token: string; wsPort?: number }
        if (
          pendingTokenRef.current !== tokenAttempt
          || generation !== connectionGenerationRef.current
          || isOffline()
          || !isCurrentWsAccount(viewerUserId)
        ) return
        if (viewerUserId !== undefined && body.userId !== viewerUserId) {
          reportTokenAttempt(tokenAttempt, "failure")

          stopCredentialRetry()
          return
        }
        reportTokenAttempt(tokenAttempt, "success")
        userId = body.userId
        authToken = body.token
        if (body.wsPort) wsPort = body.wsPort
        wsPortRef.current = wsPort
      } catch (err) {
        if (
          pendingTokenRef.current !== tokenAttempt
          || generation !== connectionGenerationRef.current
          || isOffline()
          || !isCurrentWsAccount(viewerUserId)
        ) return
        if (tokenController.signal.aborted || tokenTimedOut) return
        reportTokenAttempt(tokenAttempt, "failure")

        console.warn("[ws] token fetch error:", err)
        scheduleReconnect(generation)
        return
      } finally {
        if (pendingTokenRef.current === tokenAttempt) {
          if (tokenTimeoutRef.current !== null) {
            clearTimeout(tokenTimeoutRef.current)
            tokenTimeoutRef.current = null
          }
          pendingTokenRef.current = null
        }
      }
    }

    if (generation !== connectionGenerationRef.current || isOffline() || !isCurrentWsAccount(viewerUserId)) return

    const wsBaseUrl = useLocalServices
      ? websocketUrl("user", { local: true, port: wsPort })
      : websocketUrl("user", { local: false, origin: location.origin })
    const url = `${wsBaseUrl}?userId=${userId}`

    let protocolRejected = false

    let communityContract: CommunityContract = COMMUNITY_CONTRACT_VERSION
    const requestedCommunityContract = requestedCommunityContractRef.current
    let communityAdmission = Promise.resolve()
    let pendingAdmissions = 0
    let ws: WebSocket
    let socketObservation: PageOperation | undefined
    try {
      if (generation !== connectionGenerationRef.current || isOffline() || !isCurrentWsAccount(viewerUserId)) return
      retireSocket(true)
      if (generation !== connectionGenerationRef.current || isOffline() || !isCurrentWsAccount(viewerUserId)) return
      socketObservation = startPageOperation("ws.connect", { phase: "transport" }, observationPage)
      ws = new WebSocket(url)
    } catch (err) {
      finishPageOperation(socketObservation, "error")
      if (generation !== connectionGenerationRef.current) return

      console.warn("[ws] WebSocket creation failed:", err)
      scheduleReconnect(generation)
      return
    }
    observedSockets.current.set(ws, { generation: observationGeneration, start: performance.now(), operation: socketObservation })
    if (observationGeneration === telemetryGeneration()) emitTelemetry("ws.connect", { ...pageOperationAttributes(socketObservation), phase: "transport", outcome: "observed" })
    wsRef.current = ws
    connectStartedAtRef.current = Date.now()
    connectTimeoutRef.current = setTimeout(() => {
      if (!ownsConnection(ws, generation)) return
      recoverTimedOutConnection(ws, generation)
    }, WS_CONNECTION_VALIDATION_TIMEOUT_MS)

    ws.onopen = () => {
      if (!ownsConnection(ws, generation)) return
      if (isOffline()) {
        closeSocket(ws)
        return
      }

      try {
        ws.send(JSON.stringify({ type: "auth", token: authToken, communityContract: requestedCommunityContract }))
      } catch {

        closeSocket(ws)
      }
    }

    ws.onmessage = (e) => {
      if (!ownsConnection(ws, generation) || isOffline()) return
      lastMessageAtRef.current = Date.now()
      if (typeof e.data !== "string") {
        reportDroppedFrame("invalid-json")
        return
      }
      if (e.data === "pong") return
      let parsed: unknown
      try {
        parsed = JSON.parse(e.data)
      } catch {
        reportDroppedFrame("invalid-json")
        return
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        reportDroppedFrame("non-object")
        return
      }
      const msg = parsed as Record<string, unknown>
      if (msg.type === "auth.error") {
        protocolRejected = true
        if (Number.isSafeInteger(msg.communityContract) && Number(msg.communityContract) > 0 && msg.communityContract !== requestedCommunityContract) requestBusinessSchemaUpdate(Number(msg.communityContract))
        ws.close(1008, "Community contract mismatch")
        return
      }
      if (typeof msg.type !== "string" || msg.type.length === 0) {
        reportDroppedFrame("missing-type", msg)
        return
      }
      if (msg.type === "connection.pong") {
        const pending = connectionValidationRef.current
        if (
          isUserWsConnectionPong(msg)
          && pending?.ws === ws
          && pending.generation === generation
          && pending.nonce === msg.nonce
          && authenticatedGenerationRef.current === generation
        ) {
          const disconnectedAt = disconnectedAtRef.current
          clearConnectionValidation()
          publishConnectionPhase("authenticated")
          if (
            isOffline()
            || !ownsAuthenticatedConnection(ws, generation)
          ) return
          if (disconnectedAt !== null) {
            disconnectedAtRef.current = null
            runLifecycleCallback("reconnect", () =>
              onReconnectRef.current?.({
                reconnectDurationMs: Math.max(0, Date.now() - disconnectedAt),
              }))
            if (isOffline() || !ownsAuthenticatedConnection(ws, generation)) return
          }
          startHeartbeat(ws, generation)
        }
        return
      }
      if (msg.type === "auth.ok") {
        if (authenticatedGenerationRef.current === generation) {
          reportDroppedFrame("duplicate-auth-ok", msg)
          return
        }
        const confirmed = msg.communityContract
        if (confirmed !== COMMUNITY_CONTRACT_VERSION || confirmed !== requestedCommunityContract) {
          protocolRejected = true
          if (Number.isSafeInteger(confirmed) && Number(confirmed) > 0) requestBusinessSchemaUpdate(Number(confirmed))
          reportDroppedFrame("invalid-payload", msg)
          ws.close(1008, "Community contract confirmation mismatch")
          return
        }
        communityContract = confirmed

        authenticatedGenerationRef.current = generation
        if (connectTimeoutRef.current !== null) {
          clearTimeout(connectTimeoutRef.current)
          connectTimeoutRef.current = null
        }
        const isReconnect = hasAuthenticatedBeforeRef.current
        hasAuthenticatedBeforeRef.current = true
        const reconnectDurationMs = disconnectedAtRef.current === null
          ? 0
          : Math.max(0, Date.now() - disconnectedAtRef.current)
        disconnectedAtRef.current = null
        publishConnectionPhase("authenticated")
        if (!ownsAuthenticatedConnection(ws, generation) || isOffline()) return
        runLifecycleCallback("authenticated", onAuthenticatedRef.current)
        if (!ownsAuthenticatedConnection(ws, generation) || isOffline()) return
        if (isReconnect) {
          runLifecycleCallback("reconnect", () =>
            onReconnectRef.current?.({ reconnectDurationMs }))
          if (!ownsAuthenticatedConnection(ws, generation) || isOffline()) return
        }
        reconnectDelay.current = WS_RECONNECT_INIT
        reconnectAttemptRef.current = 0
        if (!ownsAuthenticatedConnection(ws, generation) || isOffline()) return
        startHeartbeat(ws, generation)
        return
      }
      if (authenticatedGenerationRef.current !== generation) {
        reportDroppedFrame("pre-auth-frame", msg)
        return
      }
      const isCommunityBatch = isCommunityBrowserEventBatchCandidate(msg)
      if (isCommunityEventCandidate(msg) || isCommunityBatch) {
        const byteCount = new TextEncoder().encode(e.data).byteLength
        const maxBytes = isCommunityBatch
          ? COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES
          : COMMUNITY_BROWSER_EVENT_MAX_BYTES
        if (byteCount > maxBytes) {
          reportDroppedFrame("oversized", msg, byteCount)
          return
        }
      }
      if ((isCommunityBatch && msg.type !== communityBrowserEventBatchType(communityContract))
        || (isCommunityEventCandidate(msg) && !isCommunityBatch && msg.schemaVersion !== communityContract)) {
        protocolRejected = true
        if (Number.isSafeInteger(msg.schemaVersion) && Number(msg.schemaVersion) > 0 && msg.schemaVersion !== communityContract) requestBusinessSchemaUpdate(Number(msg.schemaVersion))
        reportDroppedFrame("invalid-payload", msg)
        ws.close(1008, "Community contract mismatch")
        return
      }

      const callback = onMessageRef.current
      const assertAdmissionCurrent = () => {
        if (!ownsAuthenticatedConnection(ws, generation) || isOffline() || callback !== onMessageRef.current) throw new DOMException("Retired WebSocket admission", "AbortError")
      }
      if (isCommunityBatch || pendingAdmissions > 0) {
        if (pendingAdmissions >= 32) { ws.close(1011, "Community admission overloaded"); return }
        pendingAdmissions++
        communityAdmission = communityAdmission.then(async () => {
          if (!ownsAuthenticatedConnection(ws, generation) || isOffline() || callback !== onMessageRef.current) return
          await callback(msg as WsMessageIncoming, assertAdmissionCurrent, communityContract)
        }).catch(() => { reportDroppedFrame("invalid-payload", msg) }).finally(() => { pendingAdmissions-- })
        return
      }
      try {
        const callbackResult = callback(msg as WsMessageIncoming, undefined, communityContract)
        if (callbackResult) void callbackResult.catch(() => reportDroppedFrame("invalid-payload", msg))
      } catch {
        console.warn("[ws] message callback threw", {
          type: /^[a-z0-9_.:-]+$/i.test(msg.type) && msg.type.length <= 96 ? msg.type : "unknown",
        })
      }
    }

    ws.onerror = () => {}

    ws.onclose = (event) => {
      reportSocketClose(ws, event)
      if (!ownsConnection(ws, generation)) return
      const validation = connectionValidationRef.current
      const failedValidation = Boolean(
        validation?.ws === ws
        && validation.generation === generation
      )
      if (failedValidation) {
        clearConnectionValidation()
      }
      const wasAuthenticated = authenticatedGenerationRef.current === generation
      wsRef.current = null
      if (wasAuthenticated) {
        authenticatedGenerationRef.current = null
        disconnectedAtRef.current ??= Date.now()
        runLifecycleCallback("disconnect", onDisconnectRef.current)
        if (generation !== connectionGenerationRef.current) return
      }
      stopHeartbeat()
      if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
      if (!wasAuthenticated && viewerUserId !== undefined && !protocolRejected && isWsCredentialRejection(event)) {
        if (sdkSession) credentialRetryRef.current.rejectedSessionId = sdkSession.session.id
        else stopCredentialRetry()
      }
      publishConnectionPhase(
        isBackground() || frozenRef.current ? "suspended" : "reconnecting",
      )
      if (generation !== connectionGenerationRef.current) return
      if (protocolRejected) { credentialRetryRef.current.stopped = true; return }
      if (failedValidation && !isBackground() && !isOffline() && !frozenRef.current) {
        void connectRef.current?.()
      } else {
        scheduleReconnect(generation)
      }
    }
  }, [
    clearConnectionValidation,
    closeSocket,
    isBackground,
    isOffline,
    ownsAuthenticatedConnection,
    ownsConnection,
    publishConnectionPhase,
    reportSocketClose,
    reportTokenAttempt,
    retireSocket,
    recoverTimedOutConnection,
    scheduleReconnect,
    startHeartbeat,
    stopCredentialRetry,
    stopHeartbeat,
    viewerUserId,
  ])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const suspendConnection = useCallback((retireAuthenticatedSocket: boolean) => {
    connectionValidationNeededRef.current = true
    clearConnectionValidation()
    stopHeartbeat()
    publishConnectionPhase("suspended")
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const generation = connectionGenerationRef.current
    const ws = wsRef.current
    const authenticated = authenticatedGenerationRef.current === generation
    if (!retireAuthenticatedSocket && authenticated && ws?.readyState === WebSocket.OPEN) return

    connectionGenerationRef.current += 1
    abortPendingToken()
    retireSocket(
      retireAuthenticatedSocket,
    )
  }, [abortPendingToken, clearConnectionValidation, publishConnectionPhase, retireSocket, stopHeartbeat])

  const suspendForOffline = useCallback(() => {
    offlineRef.current = true
    if (offlineCleanupAppliedRef.current) return
    offlineCleanupAppliedRef.current = true
    connectionValidationNeededRef.current = true
    clearConnectionValidation()
    stopHeartbeat()
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    abortPendingToken()

    const ws = wsRef.current
    const generation = connectionGenerationRef.current
    const retainAuthenticatedSocket = ws
      ? ownsAuthenticatedConnection(ws, generation)
      : false
    if (retainAuthenticatedSocket) {
      disconnectedAtRef.current ??= Date.now()
    } else {
      connectionGenerationRef.current += 1
      retireSocket(true)
    }
    const parked = retainAuthenticatedSocket || isBackground() || frozenRef.current
    publishConnectionPhase(parked ? "suspended" : "reconnecting")
  }, [
    abortPendingToken,
    clearConnectionValidation,
    isBackground,
    ownsAuthenticatedConnection,
    publishConnectionPhase,
    retireSocket,
    stopHeartbeat,
  ])

  const requestForegroundRecovery = useCallback((
    trigger: CommunityWsLifecycleRecoveryTrigger,
    forceValidation: boolean,
  ) => {
    if (isOffline()) {
      connectionValidationNeededRef.current = true
      const ws = wsRef.current
      const generation = connectionGenerationRef.current
      if (!ws || !ownsAuthenticatedConnection(ws, generation)) {
        publishConnectionPhase("reconnecting")
      }
      return
    }
    if (isBackground()) {
      suspendConnection(false)
      return
    }

    frozenRef.current = false
    const recoveryNeeded = forceValidation || connectionValidationNeededRef.current
    if (!recoveryNeeded) return

    if (connectionValidationRef.current) return
    if (trigger !== "focus" || connectionValidationNeededRef.current) runLifecycleCallback("foreground", onForegroundRef.current)
    if (isOffline() || isBackground()) return
    if (pendingTokenRef.current) return

    const ws = wsRef.current
    const generation = connectionGenerationRef.current
    const authenticated = authenticatedGenerationRef.current === generation
    const awaitingAuthentication = (
      ws?.readyState === WebSocket.CONNECTING
      || ws?.readyState === WebSocket.OPEN
    )
      && !authenticated
      && Date.now() - connectStartedAtRef.current <= WS_CONNECTION_VALIDATION_TIMEOUT_MS
    if (authenticated && ws?.readyState === WebSocket.OPEN) {
      connectionValidationNeededRef.current = false

      validateCurrentConnection(ws, generation)
      return
    }
    if (awaitingAuthentication) return

    connectionValidationNeededRef.current = false
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    retireSocket(true)
    if (generation !== connectionGenerationRef.current || isOffline()) return

    void connectRef.current?.()
  }, [
    isBackground,
    isOffline,
    ownsAuthenticatedConnection,
    publishConnectionPhase,
    retireSocket,
    suspendConnection,
    validateCurrentConnection,
  ])

  useEffect(() => {
    if (previousViewerRef.current !== viewerUserId) {
      previousViewerRef.current = viewerUserId
      credentialRetryRef.current = { rejectedSessionId: null, refreshUsed: false, stopped: false, refetchUsed: false }
      wsPortRef.current = WS_DO_PORT_DEFAULT
      hasAuthenticatedBeforeRef.current = false
      authenticatedGenerationRef.current = null
      disconnectedAtRef.current = null
      reconnectDelay.current = WS_RECONNECT_INIT
      reconnectAttemptRef.current = 0
    }
    if (!viewerUserId) return
    return authClient.$store.atoms.session.listen((current, previous) => {
      if (current.isPending || current.error) return
      const sameOwner = current.data?.user?.id === viewerUserId
      const previousSession = previous?.data?.session
      const session = current.data?.session
      const changed = previousSession?.id !== session?.id || previousSession?.token !== session?.token
      if (sameOwner && !changed) return
      if (sameOwner) {
        credentialRetryRef.current = { rejectedSessionId: null, refreshUsed: false, stopped: false, refetchUsed: false }
        if (!previousSession && (wsRef.current || pendingTokenRef.current)) return
      } else credentialRetryRef.current.stopped = true
      connectionGenerationRef.current += 1
      abortPendingToken()
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      retireSocket(true)
      if (sameOwner) void connectRef.current?.()
    })
  }, [abortPendingToken, retireSocket, viewerUserId])

  useEffect(() => {
    const mountedAt = Date.now()
    lastSentinelTickAtRef.current = mountedAt
    void connect()
    const onVisibilityChange = () => {
      if (isBackground()) {
        suspendConnection(false)
        return
      }
      requestForegroundRecovery("visibility", false)
    }
    const onFreeze = () => {
      frozenRef.current = true
      suspendConnection(true)
    }
    const onResume = () => requestForegroundRecovery("resume", true)
    const onPageShow = (event: PageTransitionEvent) => {
      requestForegroundRecovery("pageshow", event.persisted)
    }
    const onWindowFocus = (event: FocusEvent) => {
      if (event.target !== window) return
      requestForegroundRecovery("focus", true)
    }
    const onOnline = () => {
      if (!offlineRef.current) return
      offlineRef.current = false
      offlineCleanupAppliedRef.current = false
      connectionValidationNeededRef.current = true
      requestForegroundRecovery("online", true)
    }
    const onOffline = () => suspendForOffline()
    const unlistenNative = listenNativeWindowLifecycle({
      suspended: () => {
        nativeSuspendedRef.current = true
        suspendConnection(false)
      },
      resumed: () => {
        nativeSuspendedRef.current = false
        requestForegroundRecovery("resume", true)
      },
    })
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange)
      document.addEventListener("freeze", onFreeze)
      document.addEventListener("resume", onResume)
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", onPageShow)
      window.addEventListener("focus", onWindowFocus)
      window.addEventListener("online", onOnline)
      window.addEventListener("offline", onOffline)
    }
    sentinelIntervalRef.current = setInterval(() => {
      const now = Date.now()
      const elapsedMs = Math.max(0, now - lastSentinelTickAtRef.current)
      lastSentinelTickAtRef.current = now
      if (
        isBackground()
        || isOffline()
        || elapsedMs < WS_FOREGROUND_SUSPENSION_GAP_MS
      ) return
      requestForegroundRecovery("sentinel", true)
    }, WS_FOREGROUND_SENTINEL_INTERVAL_MS)
    return () => {
      unlistenNative()
      nativeSuspendedRef.current = false
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange)
        document.removeEventListener("freeze", onFreeze)
        document.removeEventListener("resume", onResume)
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pageshow", onPageShow)
        window.removeEventListener("focus", onWindowFocus)
        window.removeEventListener("online", onOnline)
        window.removeEventListener("offline", onOffline)
      }
      if (sentinelIntervalRef.current !== null) {
        clearInterval(sentinelIntervalRef.current)
        sentinelIntervalRef.current = null
      }
      connectionGenerationRef.current += 1
      clearConnectionValidation()
      abortPendingToken()
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
      stopHeartbeat()
      retireSocket(false)
    }
  }, [
    abortPendingToken,
    clearConnectionValidation,
    connect,
    isBackground,
    isOffline,
    requestForegroundRecovery,
    retireSocket,
    stopHeartbeat,
    suspendConnection,
    suspendForOffline,
  ])

  const send = useCallback((msg: object) => {
    const ws = wsRef.current
    if (!isOffline() && isCurrentWsAccount(viewerUserId) && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(isCommunityEventCandidate(msg) ? { ...msg, schemaVersion: COMMUNITY_CONTRACT_VERSION } : msg))
    }
  }, [isOffline, viewerUserId])

  const reconnectNow = useCallback(() => {
    credentialRetryRef.current = {
      rejectedSessionId: credentialRetryRef.current.rejectedSessionId,
      refreshUsed: false, stopped: false, refetchUsed: false,
    }
    clearConnectionValidation()
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    abortPendingToken()
    if (isOffline()) {
      connectionValidationNeededRef.current = true
      stopHeartbeat()
      const ws = wsRef.current
      const generation = connectionGenerationRef.current
      publishConnectionPhase(
        ws && ownsAuthenticatedConnection(ws, generation) ? "suspended" : "reconnecting",
      )
      return
    }
    retireSocket(true)
    if (isBackground() || frozenRef.current) {
      connectionGenerationRef.current += 1
      publishConnectionPhase("suspended")
      return
    }
    void connectRef.current?.()
  }, [
    abortPendingToken,
    clearConnectionValidation,
    isBackground,
    isOffline,
    ownsAuthenticatedConnection,
    publishConnectionPhase,
    retireSocket,
    stopHeartbeat,
  ])

  return { send, reconnectNow }
}
