"use client"
import { useEffect, useRef, useCallback } from "react"
import {
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
  onReconnect?: (info: { reconnectDurationMs: number }) => void | Promise<void>
  onDisconnect?: () => void | Promise<void>
  onAuthenticated?: () => void | Promise<void>
  onConnectionStateChange?: (phase: UserWsConnectionPhase) => void | Promise<void>
  requestDaemonStatusOnAuth?: boolean
}

function runLifecycleCallback(
  name: "authenticated" | "connection-state" | "disconnect" | "reconnect",
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
  onMessage: (msg: WsMessageIncoming) => void,
  options?: UseUserWsOptions,
): { send: (msg: object) => void; reconnectNow: () => void } {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(WS_RECONNECT_INIT)
  const reconnectAttemptRef = useRef(0)
  const onMessageRef = useRef(onMessage)
  const onReconnectRef = useRef(options?.onReconnect)
  const onDisconnectRef = useRef(options?.onDisconnect)
  const onAuthenticatedRef = useRef(options?.onAuthenticated)
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
  }, [onMessage])

  useEffect(() => {
    onReconnectRef.current = options?.onReconnect
  }, [options?.onReconnect])

  useEffect(() => {
    onDisconnectRef.current = options?.onDisconnect
    onAuthenticatedRef.current = options?.onAuthenticated
    onConnectionStateChangeRef.current = options?.onConnectionStateChange
  }, [
    options?.onAuthenticated,
    options?.onConnectionStateChange,
    options?.onDisconnect,
  ])

  useEffect(() => {
    requestDaemonStatusOnAuthRef.current = options?.requestDaemonStatusOnAuth ?? true
  }, [options?.requestDaemonStatusOnAuth])

  const connectRef = useRef<(() => Promise<void>) | null>(null)

  const publishConnectionPhase = useCallback((phase: UserWsConnectionPhase) => {
    if (lastConnectionPhaseRef.current === phase) return
    lastConnectionPhaseRef.current = phase
    runLifecycleCallback("connection-state", () =>
      onConnectionStateChangeRef.current?.(phase))
  }, [])

  const ownsConnection = useCallback((ws: WebSocket, generation: number) => (
    ws === wsRef.current && generation === connectionGenerationRef.current
  ), [])

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

  const startHeartbeat = useCallback((ws: WebSocket, generation: number) => {
    stopHeartbeat()
    if (
      isPageHidden()
      || isOffline()
      || frozenRef.current
      || !ownsAuthenticatedConnection(ws, generation)
    ) return
    lastMessageAtRef.current = Date.now()
    pingIntervalRef.current = setInterval(() => {
      if (
        !isOffline()
        && !isPageHidden()
        && !frozenRef.current
        && ownsAuthenticatedConnection(ws, generation)
      ) ws.send("ping")
    }, 25_000)
    livenessIntervalRef.current = setInterval(() => {
      if (
        !isOffline()
        && ownsAuthenticatedConnection(ws, generation)
        && Date.now() - lastMessageAtRef.current > 30_000
      ) closeSocket(ws, "heartbeat-timeout")
    }, 5_000)
  }, [closeSocket, isOffline, ownsAuthenticatedConnection, stopHeartbeat])

  const retireSocket = useCallback((
    reportDisconnect: boolean,
    initiator: CommunityWsCloseInitiator,
    validationResult: CommunityWsLifecycleStageResult = "aborted",
  ) => {
    const ws = wsRef.current
    wsRef.current = null
    clearConnectionValidation(validationResult)
    if (reportDisconnect && authenticatedGenerationRef.current !== null) {
      authenticatedGenerationRef.current = null
      disconnectedAtRef.current ??= Date.now()
      runLifecycleCallback("disconnect", onDisconnectRef.current)
    }
    stopHeartbeat()
    if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    if (ws) closeSocket(ws, initiator)
  }, [clearConnectionValidation, closeSocket, stopHeartbeat])

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
    clearConnectionValidation(result)
    retireSocket(true, initiator, result)
    if (generation !== connectionGenerationRef.current) return
    const parked = isPageHidden() || frozenRef.current
    publishConnectionPhase(parked ? "suspended" : "reconnecting")
    if (generation !== connectionGenerationRef.current) return
    if (!parked && !isOffline()) void connectRef.current?.()
  }, [clearConnectionValidation, isOffline, publishConnectionPhase, retireSocket])

  const validateCurrentConnection = useCallback((ws: WebSocket, generation: number) => {
    if (
      isOffline()
      || isPageHidden()
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
    isOffline,
    ownsAuthenticatedConnection,
    stopHeartbeat,
  ])

  const scheduleReconnect = useCallback((generation: number) => {
    if (generation !== connectionGenerationRef.current) return
    if (isPageHidden() || isOffline() || frozenRef.current) return
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const windowMs = Math.min(reconnectDelay.current, WS_RECONNECT_MAX)
    const delayMs = Math.floor(Math.random() * windowMs)
    const attempt = reconnectAttemptRef.current + 1
    reconnectAttemptRef.current = attempt
    reconnectDelay.current = Math.min(windowMs * 2, WS_RECONNECT_MAX)
    trackCommunityWsRetryScheduled({ attempt, delayMs, windowMs })
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      if (
        generation !== connectionGenerationRef.current
        || isPageHidden()
        || isOffline()
        || frozenRef.current
      ) return
      void connectRef.current?.()
    }, delayMs)
  }, [isOffline])

  const connect = useCallback(async () => {
    if (isPageHidden() || isOffline() || frozenRef.current) {
      publishConnectionPhase(
        isPageHidden() || frozenRef.current ? "suspended" : "reconnecting",
      )
      return
    }
    if (pendingTokenRef.current) return
    const previousGeneration = connectionGenerationRef.current
    publishConnectionPhase("reconnecting")
    if (
      pendingTokenRef.current
      || previousGeneration !== connectionGenerationRef.current
      || isPageHidden()
      || isOffline()
      || frozenRef.current
    ) return
    const generation = previousGeneration + 1
    connectionGenerationRef.current = generation
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const tokenController = new AbortController()
    const tokenAttempt: PendingTokenAttempt = {
      controller: tokenController,
      generation,
      startedAt: Date.now(),
      reported: false,
    }
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
    let userId: string
    let authToken: string
    let wsPort: number = WS_DO_PORT_DEFAULT
    let tokenResponseReceived = false
    try {
      const res = await fetch("/api/ws/token", { signal: tokenController.signal })
      tokenResponseReceived = true
      if (
        pendingTokenRef.current !== tokenAttempt
        || generation !== connectionGenerationRef.current
        || isOffline()
      ) return
      if (!res.ok) {
        reportTokenAttempt(tokenAttempt, "failure")
        trackCommunityWsAuthFailure({ failureClass: tokenFailureClass(res.status) })
        console.warn("[ws] token fetch failed:", res.status)
        scheduleReconnect(generation)
        return
      }
      const body = await res.json() as { userId: string; token: string; wsPort?: number }
      if (
        pendingTokenRef.current !== tokenAttempt
        || generation !== connectionGenerationRef.current
        || isOffline()
      ) return
      reportTokenAttempt(tokenAttempt, "success")
      userId = body.userId
      authToken = body.token
      if (body.wsPort) wsPort = body.wsPort
    } catch (err) {
      if (
        pendingTokenRef.current !== tokenAttempt
        || generation !== connectionGenerationRef.current
        || isOffline()
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

    if (generation !== connectionGenerationRef.current || isOffline()) return

    const wsBaseUrl = useLocalServices
      ? websocketUrl("user", { local: true, port: wsPort })
      : websocketUrl("user", { local: false, origin: location.origin })
    const url = `${wsBaseUrl}?userId=${userId}`

    const socketStartedAt = Date.now()
    let openedAt = 0
    let openStageReported = false
    let authStageReported = false
    let authFailureReported = false
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

    let ws: WebSocket
    try {
      if (generation !== connectionGenerationRef.current || isOffline()) return
      retireSocket(true, "local-retire")
      if (generation !== connectionGenerationRef.current || isOffline()) return
      ws = new WebSocket(url)
    } catch (err) {
      if (generation !== connectionGenerationRef.current) return
      reportOpenStage("failure")
      console.warn("[ws] WebSocket creation failed:", err)
      scheduleReconnect(generation)
      return
    }
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
      closeSocket(ws, "connect-timeout")
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
        ws.send(JSON.stringify({ type: "auth", token: authToken }))
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
          clearConnectionValidation("success")
          publishConnectionPhase("authenticated")
          if (
            isOffline()
            || !ownsAuthenticatedConnection(ws, generation)
          ) return
          startHeartbeat(ws, generation)
        }
        return
      }
      if (msg.type === "auth.ok") {
        if (authenticatedGenerationRef.current === generation) {
          reportDroppedFrame("duplicate-auth-ok", msg)
          return
        }
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
      try {
        onMessageRef.current(msg as WsMessageIncoming)
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
          reportAuthFailure(code === 1008 ? "credentials" : "network")
        } else if (initiator === "remote") {
          const code = normalizedCloseCode(event?.code)
          reportAuthFailure(code === 1008 ? "credentials" : code === 1011 ? "server" : "network")
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
      publishConnectionPhase(
        isPageHidden() || frozenRef.current ? "suspended" : "reconnecting",
      )
      if (generation !== connectionGenerationRef.current) return
      if (failedValidation && !isPageHidden() && !isOffline() && !frozenRef.current) {
        void connectRef.current?.()
      } else {
        scheduleReconnect(generation)
      }
    }
  }, [
    clearConnectionValidation,
    closeSocket,
    isOffline,
    ownsAuthenticatedConnection,
    ownsConnection,
    publishConnectionPhase,
    reportSocketClose,
    reportTokenAttempt,
    retireSocket,
    scheduleReconnect,
    startHeartbeat,
    stopHeartbeat,
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
    if (!retainAuthenticatedSocket) {
      connectionGenerationRef.current += 1
      retireSocket(true, "offline")
    }
    const parked = retainAuthenticatedSocket || isPageHidden() || frozenRef.current
    publishConnectionPhase(parked ? "suspended" : "reconnecting")
  }, [
    abortPendingToken,
    clearConnectionValidation,
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
    if (isPageHidden() || isOffline() || frozenRef.current) return
    trackCommunityWsLifecycleRecovery({
      trigger,
      strategy,
      socketReadyState: readyState,
      suspensionDuration: suspensionDurationBucket(suspendedAtRef.current, now),
    })
    suspendedAtRef.current = null
  }, [isOffline])

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
    if (isPageHidden()) {
      suspendConnection(false)
      return
    }

    frozenRef.current = false
    const recoveryNeeded = forceValidation || connectionValidationNeededRef.current
    if (!recoveryNeeded) return

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
      if (connectionValidationRef.current?.ws === ws) return
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
    isOffline,
    ownsAuthenticatedConnection,
    publishConnectionPhase,
    retireSocket,
    suspendConnection,
    trackLifecycleRecovery,
    validateCurrentConnection,
  ])

  useEffect(() => {
    const mountedAt = Date.now()
    if (isPageHidden() || isOffline()) suspendedAtRef.current = mountedAt
    lastSentinelTickAtRef.current = mountedAt
    void connect()
    const onVisibilityChange = () => {
      if (isPageHidden()) {
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
        isPageHidden()
        || isOffline()
        || elapsedMs < WS_FOREGROUND_SUSPENSION_GAP_MS
      ) return
      requestForegroundRecovery("sentinel", true)
    }, WS_FOREGROUND_SENTINEL_INTERVAL_MS)
    return () => {
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
    isOffline,
    requestForegroundRecovery,
    retireSocket,
    stopHeartbeat,
    suspendConnection,
    suspendForOffline,
  ])

  const send = useCallback((msg: object) => {
    const ws = wsRef.current
    if (!isOffline() && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [isOffline])

  const reconnectNow = useCallback(() => {
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
    if (isPageHidden() || frozenRef.current) {
      connectionGenerationRef.current += 1
      publishConnectionPhase("suspended")
      return
    }
    void connectRef.current?.()
  }, [
    abortPendingToken,
    clearConnectionValidation,
    isOffline,
    ownsAuthenticatedConnection,
    publishConnectionPhase,
    retireSocket,
    stopHeartbeat,
  ])

  return { send, reconnectNow }
}
