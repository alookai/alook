"use client"
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
  trackCommunityWsAuthFailure,
  trackCommunityWsFrameDropped,
  trackCommunityWsLifecycleClose,
  trackCommunityWsLifecycleRecovery,
  trackCommunityWsLifecycleStage,
  trackCommunityWsRetryScheduled,
  type CommunityWsAuthFailureClass,
  type CommunityWsCloseInitiator,
  type CommunityWsCloseReasonBucket,
  type CommunityWsFrameDropReason,
  type CommunityWsLifecycleStageResult,
  type CommunityWsLifecycleRecoveryStrategy,
  type CommunityWsLifecycleRecoveryTrigger,
  type CommunityWsSocketReadyState,
  type CommunityWsSuspensionDurationBucket,
} from "@/lib/analytics"
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
  startedAt: number
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

function closeReasonBucket(code: number): CommunityWsCloseReasonBucket {
  if (code === 1000) return "normal"
  if (code === 1001) return "going-away"
  if (code === 1005 || code === 1006) return "abnormal"
  if (code === 1008) return "policy"
  if (code === 1011) return "server-error"
  if (code === 0) return "unknown"
  return "other"
}

function tokenFailureClass(status: number): CommunityWsAuthFailureClass {
  if (status === 401 || status === 403) return "credentials"
  if (status >= 500) return "server"
  return "unknown"
}

function socketReadyState(ws: WebSocket | null): CommunityWsSocketReadyState {
  if (!ws) return "none"
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return "connecting"
    case WebSocket.OPEN:
      return "open"
    case WebSocket.CLOSING:
      return "closing"
    default:
      return "closed"
  }
}

function suspensionDurationBucket(
  suspendedAt: number | null,
  now: number,
): CommunityWsSuspensionDurationBucket {
  if (suspendedAt === null) return "unknown"
  const durationMs = Math.max(0, now - suspendedAt)
  if (durationMs < 30_000) return "under-30s"
  if (durationMs < 120_000) return "30s-2m"
  return "over-2m"
}

/**
 * Incoming WS message shape delivered to the `onMessage` handler.
 *
 * This is the intersection of the discriminated `WsMessage` union with an
 * index signature — the union preserves narrowing (`switch (msg.type)` on
 * concrete callers), while the index signature lets consumers that need to
 * inspect fields dynamically (e.g. the community WS router that uses
 * `isCommunityEvent`) accept the same value without an `as any` cast.
 */
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
  requestDaemonStatusOnAuth?: boolean
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
  trackCommunityWsFrameDropped(metadata)
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
  const requestDaemonStatusOnAuthRef = useRef(options?.requestDaemonStatusOnAuth ?? true)
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
  const suspendedAtRef = useRef<number | null>(null)
  const sentinelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSentinelTickAtRef = useRef(0)
  const offlineRef = useRef(isBrowserOffline())
  const offlineCleanupAppliedRef = useRef(false)
  const localCloseInitiatorRef = useRef(new WeakMap<WebSocket, CommunityWsCloseInitiator>())
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

  useEffect(() => {
    requestDaemonStatusOnAuthRef.current = options?.requestDaemonStatusOnAuth ?? true
  }, [options?.requestDaemonStatusOnAuth])

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

  const clearConnectionValidation = useCallback((
    result?: CommunityWsLifecycleStageResult,
  ) => {
    const pending = connectionValidationRef.current
    connectionValidationRef.current = null
    if (pending) clearTimeout(pending.timeout)
    if (pending && result) {
      trackCommunityWsLifecycleStage({
        stage: "validation",
        result,
        durationMs: boundedDurationMs(pending.startedAt),
      })
    }
  }, [])

  const reportTokenAttempt = useCallback((
    attempt: PendingTokenAttempt,
    result: CommunityWsLifecycleStageResult,
  ) => {
    if (attempt.reported) return
    attempt.reported = true
    finishPageOperation(attempt.operation, result === "success" ? "success" : result === "aborted" ? "cancelled" : result === "timeout" ? "timeout" : "error")
    if (attempt.observationGeneration === telemetryGeneration()) emitTelemetry("ws.connect", { ...pageOperationAttributes(attempt.operation), phase: "token", outcome: result === "success" ? "success" : result === "aborted" ? "cancelled" : result === "timeout" ? "timeout" : "error", duration_ms: attempt.operation ? performance.now() - attempt.operation.start : boundedDurationMs(attempt.startedAt) })
    trackCommunityWsLifecycleStage({
      stage: "token",
      result,
      durationMs: boundedDurationMs(attempt.startedAt),
    })
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

  const closeSocket = useCallback((ws: WebSocket, initiator: CommunityWsCloseInitiator) => {
    if (
      !localCloseInitiatorRef.current.has(ws)
      && ws.readyState !== WebSocket.CLOSING
      && ws.readyState !== WebSocket.CLOSED
    ) {
      localCloseInitiatorRef.current.set(ws, initiator)
    }
    ws.close()
  }, [])

  const reportSocketClose = useCallback((
    ws: WebSocket,
    event?: Pick<CloseEvent, "code" | "wasClean">,
  ): CommunityWsCloseInitiator => {
    const localInitiator = localCloseInitiatorRef.current.get(ws)
    localCloseInitiatorRef.current.delete(ws)
    const code = normalizedCloseCode(event?.code)
    const initiator = localInitiator
      ?? (authenticatedGenerationRef.current === null && code === 1008
        ? "auth-failure"
        : "remote")
    if (!reportedCloseSocketsRef.current.has(ws)) {
      reportedCloseSocketsRef.current.add(ws)
      const observed = observedSockets.current.get(ws)
      finishPageOperation(observed?.operation, localInitiator ? "cancelled" : "error")
      if (observed?.generation === telemetryGeneration()) emitTelemetry("ws.close", { ...pageOperationAttributes(observed.operation), phase: "transport", outcome: "observed", duration_ms: performance.now() - observed.start, status: code })
      trackCommunityWsLifecycleClose({
        initiator,
        code,
        wasClean: event?.wasClean === true,
        reasonBucket: closeReasonBucket(code),
      })
    }
    return initiator
  }, [])

  const stopHeartbeat = useCallback(() => {
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
    if (livenessIntervalRef.current) { clearInterval(livenessIntervalRef.current); livenessIntervalRef.current = null }
  }, [])

  const retireSocket = useCallback((
    reportDisconnect: boolean,
    initiator: CommunityWsCloseInitiator,
    validationResult: CommunityWsLifecycleStageResult = "aborted",
  ) => {
    const ws = wsRef.current
    const disconnected = reportDisconnect && authenticatedGenerationRef.current !== null
    wsRef.current = null
    clearConnectionValidation(validationResult)
    if (disconnected) {
      authenticatedGenerationRef.current = null
      disconnectedAtRef.current ??= Date.now()
    }
    stopHeartbeat()
    if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    if (ws) { finishPageOperation(observedSockets.current.get(ws)?.operation, "cancelled"); closeSocket(ws, initiator) }
    if (disconnected) runLifecycleCallback("disconnect", onDisconnectRef.current)
  }, [clearConnectionValidation, closeSocket, stopHeartbeat])

  const stopCredentialRetry = useCallback(() => {
    const retry = credentialRetryRef.current
    retry.stopped = true
    retireSocket(true, "auth-failure")
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
    trackCommunityWsRetryScheduled({ attempt, delayMs, windowMs })
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
    initiator: CommunityWsCloseInitiator,
    result: CommunityWsLifecycleStageResult = "timeout",
  ) => {
    if (!ownsConnection(ws, generation)) return
    retireSocket(true, initiator, result)
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
      ) recoverTimedOutConnection(ws, generation, "heartbeat-timeout")
    }, 5_000)
  }, [isBackground, isOffline, ownsAuthenticatedConnection, recoverTimedOutConnection, stopHeartbeat])

  const failConnectionValidation = useCallback((
    ws: WebSocket,
    generation: number,
    nonce: string,
    result: "failure" | "timeout",
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
    const initiator = result === "timeout" ? "validation-timeout" : "validation-failure"
    recoverTimedOutConnection(ws, generation, initiator, result)
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
    clearConnectionValidation("aborted")
    stopHeartbeat()
    const nonce = crypto.randomUUID()
    const pending: PendingConnectionValidation = {
      ws,
      generation,
      nonce,
      startedAt: Date.now(),
      timeout: setTimeout(() => {
        failConnectionValidation(ws, generation, nonce, "timeout")
      }, WS_CONNECTION_VALIDATION_TIMEOUT_MS),
    }
    connectionValidationRef.current = pending
    try {
      ws.send(JSON.stringify({ type: "connection.ping", nonce }))
    } catch {
      failConnectionValidation(ws, generation, nonce, "failure")
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
        trackCommunityWsAuthFailure({ failureClass: "timeout" })
        tokenController.abort()
        scheduleReconnect(generation)
      }, WS_TOKEN_TIMEOUT_MS)
      const retry = credentialRetryRef.current
      const refresh = Boolean(retry.rejectedSessionId) && !retry.refreshUsed
      if (refresh) retry.refreshUsed = true
      let tokenResponseReceived = false
      try {
        const res = await runPageOperation(tokenAttempt.operation, () => fetch(refresh ? "/api/ws/token?refresh=1" : "/api/ws/token", { signal: tokenController.signal }))
        tokenResponseReceived = true
        if (
          pendingTokenRef.current !== tokenAttempt
          || generation !== connectionGenerationRef.current
          || isOffline()
          || !isCurrentWsAccount(viewerUserId)
        ) return
        if (!res.ok) {
          reportTokenAttempt(tokenAttempt, "failure")
          trackCommunityWsAuthFailure({ failureClass: tokenFailureClass(res.status) })
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
          trackCommunityWsAuthFailure({ failureClass: "credentials" })
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
        trackCommunityWsAuthFailure({
          failureClass: tokenResponseReceived ? "unknown" : "network",
        })
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

    const socketStartedAt = Date.now()
    let openedAt = 0
    let openStageReported = false
    let authStageReported = false
    let authFailureReported = false
    let protocolRejected = false
    const reportOpenStage = (result: CommunityWsLifecycleStageResult) => {
      if (openStageReported) return
      openStageReported = true
      trackCommunityWsLifecycleStage({
        stage: "open",
        result,
        durationMs: boundedDurationMs(socketStartedAt),
      })
    }
    const reportAuthStage = (result: CommunityWsLifecycleStageResult) => {
      if (authStageReported || openedAt === 0) return
      authStageReported = true
      trackCommunityWsLifecycleStage({
        stage: "auth",
        result,
        durationMs: boundedDurationMs(openedAt),
      })
    }
    const reportAuthFailure = (failureClass: CommunityWsAuthFailureClass) => {
      if (authFailureReported) return
      authFailureReported = true
      trackCommunityWsAuthFailure({ failureClass })
    }

    let communityContract: CommunityContract = 1
    const requestedCommunityContract = requestedCommunityContractRef.current
    let communityAdmission = Promise.resolve()
    let pendingAdmissions = 0
    let ws: WebSocket
    let socketObservation: PageOperation | undefined
    try {
      if (generation !== connectionGenerationRef.current || isOffline() || !isCurrentWsAccount(viewerUserId)) return
      retireSocket(true, "local-retire")
      if (generation !== connectionGenerationRef.current || isOffline() || !isCurrentWsAccount(viewerUserId)) return
      socketObservation = startPageOperation("ws.connect", { phase: "transport" }, observationPage)
      ws = new WebSocket(url)
    } catch (err) {
      finishPageOperation(socketObservation, "error")
      if (generation !== connectionGenerationRef.current) return
      reportOpenStage("failure")
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
      if (openedAt === 0) {
        reportOpenStage("timeout")
      } else {
        reportAuthStage("timeout")
        reportAuthFailure("timeout")
      }
      recoverTimedOutConnection(ws, generation, "connect-timeout")
    }, WS_CONNECTION_VALIDATION_TIMEOUT_MS)

    ws.onopen = () => {
      if (!ownsConnection(ws, generation)) return
      if (isOffline()) {
        closeSocket(ws, "offline")
        return
      }
      openedAt = Date.now()
      reportOpenStage("success")
      try {
        ws.send(JSON.stringify({ type: "auth", token: authToken, communityContract: requestedCommunityContract }))
      } catch {
        reportAuthStage("failure")
        reportAuthFailure("network")
        closeSocket(ws, "auth-failure")
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
      if (msg.type === "auth.error") protocolRejected = true
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
          clearConnectionValidation("success")
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
        const confirmed = msg.communityContract ?? 1
        if ((confirmed !== 1 && confirmed !== 2 && confirmed !== 3)
          || (confirmed !== requestedCommunityContract && !(confirmed === 1 && requestedCommunityContract === 2))) {
          protocolRejected = true
          reportDroppedFrame("invalid-payload", msg)
          ws.close(1008, "Community contract confirmation mismatch")
          return
        }
        communityContract = confirmed
        reportAuthStage("success")
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
        if (requestDaemonStatusOnAuthRef.current) {
          try {
            ws.send(JSON.stringify({ type: "check_daemon_status" }))
          } catch {
            retireSocket(true, "local-retire")
            if (generation === connectionGenerationRef.current) {
              scheduleReconnect(generation)
            }
            return
          }
        }
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
      if ((isCommunityBatch && msg.type !== communityBrowserEventBatchType(communityContract)
        && !(communityContract === 2 && msg.type === communityBrowserEventBatchType(1)))
        || (communityContract === 1 && (msg.type === "community:channel.membership.change"
          || (isCommunityBatch && Array.isArray(msg.events) && msg.events.some((event: unknown) =>
            isCommunityEventCandidate(event) && event.type === "community:channel.membership.change"))))) {
        reportDroppedFrame("invalid-payload", msg)
        return
      }

      const callback = onMessageRef.current
      const assertAdmissionCurrent = () => {
        if (!ownsAuthenticatedConnection(ws, generation) || isOffline() || callback !== onMessageRef.current) throw new DOMException("Retired WebSocket admission", "AbortError")
      }
      if ((isCommunityBatch && msg.type !== communityBrowserEventBatchType(1)) || pendingAdmissions > 0) {
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
      const initiator = reportSocketClose(ws, event)
      const timeout = initiator === "connect-timeout"
      const aborted = initiator === "freeze"
        || initiator === "local-retire"
        || initiator === "manual-retry"
        || initiator === "offline"
      if (!openStageReported) reportOpenStage(timeout ? "timeout" : aborted ? "aborted" : "failure")
      if (openedAt !== 0 && !authStageReported) {
        reportAuthStage(timeout ? "timeout" : aborted ? "aborted" : "failure")
        if (initiator === "auth-failure") {
          const code = normalizedCloseCode(event?.code)
          reportAuthFailure(isWsCredentialRejection(event) && !protocolRejected ? "credentials" : code === 1008 ? "unknown" : "network")
        } else if (initiator === "remote") {
          const code = normalizedCloseCode(event?.code)
          reportAuthFailure(isWsCredentialRejection(event) && !protocolRejected ? "credentials" : code === 1008 ? "unknown" : code === 1011 ? "server" : "network")
        }
      }
      if (!ownsConnection(ws, generation)) return
      const validation = connectionValidationRef.current
      const failedValidation = Boolean(
        validation?.ws === ws
        && validation.generation === generation
      )
      if (failedValidation) {
        clearConnectionValidation("failure")
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
    suspendedAtRef.current ??= Date.now()
    clearConnectionValidation("aborted")
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
      retireAuthenticatedSocket ? "freeze" : "local-retire",
    )
  }, [abortPendingToken, clearConnectionValidation, publishConnectionPhase, retireSocket, stopHeartbeat])

  const suspendForOffline = useCallback(() => {
    offlineRef.current = true
    if (offlineCleanupAppliedRef.current) return
    offlineCleanupAppliedRef.current = true
    connectionValidationNeededRef.current = true
    suspendedAtRef.current ??= Date.now()
    clearConnectionValidation("aborted")
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
      retireSocket(true, "offline")
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

  const trackLifecycleRecovery = useCallback((
    trigger: CommunityWsLifecycleRecoveryTrigger,
    strategy: CommunityWsLifecycleRecoveryStrategy,
    readyState: CommunityWsSocketReadyState,
    now: number,
  ) => {
    if (isBackground() || isOffline() || frozenRef.current) return
    trackCommunityWsLifecycleRecovery({
      trigger,
      strategy,
      socketReadyState: readyState,
      suspensionDuration: suspensionDurationBucket(suspendedAtRef.current, now),
    })
    suspendedAtRef.current = null
  }, [isBackground, isOffline])

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
      trackLifecycleRecovery(trigger, "validate", socketReadyState(ws), Date.now())
      validateCurrentConnection(ws, generation)
      return
    }
    if (awaitingAuthentication) return

    connectionValidationNeededRef.current = false
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const readyState = socketReadyState(ws)
    retireSocket(true, "local-retire")
    if (generation !== connectionGenerationRef.current || isOffline()) return
    trackLifecycleRecovery(trigger, "replace", readyState, Date.now())
    void connectRef.current?.()
  }, [
    isBackground,
    isOffline,
    ownsAuthenticatedConnection,
    publishConnectionPhase,
    retireSocket,
    suspendConnection,
    trackLifecycleRecovery,
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
      retireSocket(true, "local-retire")
      if (sameOwner) void connectRef.current?.()
    })
  }, [abortPendingToken, retireSocket, viewerUserId])

  useEffect(() => {
    const mountedAt = Date.now()
    if (isBackground() || isOffline()) suspendedAtRef.current = mountedAt
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
      clearConnectionValidation("aborted")
      abortPendingToken()
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
      stopHeartbeat()
      retireSocket(false, "local-retire")
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
      ws.send(JSON.stringify(msg))
    }
  }, [isOffline, viewerUserId])

  const reconnectNow = useCallback(() => {
    credentialRetryRef.current = {
      rejectedSessionId: credentialRetryRef.current.rejectedSessionId,
      refreshUsed: false, stopped: false, refetchUsed: false,
    }
    clearConnectionValidation("aborted")
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
    retireSocket(true, "manual-retry")
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
