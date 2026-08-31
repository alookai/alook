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
  trackCommunityWsFrameDropped,
  trackCommunityWsLifecycleRecovery,
  type CommunityWsFrameDropReason,
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
  timeout: ReturnType<typeof setTimeout>
}

function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
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
  const onMessageRef = useRef(onMessage)
  const onReconnectRef = useRef(options?.onReconnect)
  const onDisconnectRef = useRef(options?.onDisconnect)
  const onAuthenticatedRef = useRef(options?.onAuthenticated)
  const onConnectionStateChangeRef = useRef(options?.onConnectionStateChange)
  const lastConnectionPhaseRef = useRef<UserWsConnectionPhase | null>(null)
  const requestDaemonStatusOnAuthRef = useRef(options?.requestDaemonStatusOnAuth ?? true)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenAbortRef = useRef<AbortController | null>(null)
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

  const clearConnectionValidation = useCallback(() => {
    const pending = connectionValidationRef.current
    connectionValidationRef.current = null
    if (pending) clearTimeout(pending.timeout)
  }, [])

  const abortPendingToken = useCallback(() => {
    tokenAbortRef.current?.abort()
    tokenAbortRef.current = null
    if (tokenTimeoutRef.current !== null) {
      clearTimeout(tokenTimeoutRef.current)
      tokenTimeoutRef.current = null
    }
  }, [])

  const stopHeartbeat = useCallback(() => {
    if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
    if (livenessIntervalRef.current) { clearInterval(livenessIntervalRef.current); livenessIntervalRef.current = null }
  }, [])

  const startHeartbeat = useCallback((ws: WebSocket, generation: number) => {
    stopHeartbeat()
    if (
      isPageHidden()
      || frozenRef.current
      || ws !== wsRef.current
      || generation !== connectionGenerationRef.current
      || authenticatedGenerationRef.current !== generation
      || ws.readyState !== WebSocket.OPEN
    ) return
    lastMessageAtRef.current = Date.now()
    pingIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping")
    }, 25_000)
    livenessIntervalRef.current = setInterval(() => {
      if (Date.now() - lastMessageAtRef.current > 30_000) ws.close()
    }, 5_000)
  }, [stopHeartbeat])

  const retireSocket = useCallback((reportDisconnect = true) => {
    const ws = wsRef.current
    wsRef.current = null
    clearConnectionValidation()
    if (reportDisconnect && authenticatedGenerationRef.current !== null) {
      authenticatedGenerationRef.current = null
      disconnectedAtRef.current ??= Date.now()
      runLifecycleCallback("disconnect", onDisconnectRef.current)
    }
    stopHeartbeat()
    if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
    ws?.close()
  }, [clearConnectionValidation, stopHeartbeat])

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
    clearConnectionValidation()
    retireSocket()
    const suspended = isPageHidden() || frozenRef.current
    publishConnectionPhase(suspended ? "suspended" : "reconnecting")
    if (!suspended) void connectRef.current?.()
  }, [clearConnectionValidation, publishConnectionPhase, retireSocket])

  const validateCurrentConnection = useCallback((ws: WebSocket, generation: number) => {
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
  }, [clearConnectionValidation, failConnectionValidation, stopHeartbeat])

  const scheduleReconnect = useCallback((generation: number) => {
    if (generation !== connectionGenerationRef.current) return
    if (isPageHidden() || frozenRef.current) return
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const delay = Math.min(reconnectDelay.current, WS_RECONNECT_MAX)
    reconnectDelay.current = Math.min(delay * 2, WS_RECONNECT_MAX)
    reconnectTimerRef.current = setTimeout(() => {
      if (generation !== connectionGenerationRef.current) return
      void connectRef.current?.()
    }, delay + Math.random() * 500)
  }, [])

  const connect = useCallback(async () => {
    if (isPageHidden() || frozenRef.current) {
      publishConnectionPhase("suspended")
      return
    }
    publishConnectionPhase("reconnecting")
    const generation = connectionGenerationRef.current + 1
    connectionGenerationRef.current = generation
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    tokenAbortRef.current?.abort()
    const tokenController = new AbortController()
    tokenAbortRef.current = tokenController
    let tokenTimedOut = false
    tokenTimeoutRef.current = setTimeout(() => {
      tokenTimedOut = true
      tokenController.abort()
    }, WS_TOKEN_TIMEOUT_MS)
    let userId: string
    let authToken: string
    let wsPort: number = WS_DO_PORT_DEFAULT
    try {
      const res = await fetch("/api/ws/token", { signal: tokenController.signal })
      if (!res.ok) {
        if (generation !== connectionGenerationRef.current) return
        console.warn("[ws] token fetch failed:", res.status)
        scheduleReconnect(generation)
        return
      }
      const body = await res.json() as { userId: string; token: string; wsPort?: number }
      if (generation !== connectionGenerationRef.current) return
      userId = body.userId
      authToken = body.token
      if (body.wsPort) wsPort = body.wsPort
    } catch (err) {
      if (generation !== connectionGenerationRef.current) return
      if (tokenController.signal.aborted && !tokenTimedOut) return
      console.warn("[ws] token fetch error:", err)
      scheduleReconnect(generation)
      return
    } finally {
      if (tokenAbortRef.current === tokenController) {
        if (tokenTimeoutRef.current !== null) {
          clearTimeout(tokenTimeoutRef.current)
          tokenTimeoutRef.current = null
        }
        tokenAbortRef.current = null
      }
    }

    const wsBaseUrl = useLocalServices
      ? websocketUrl("user", { local: true, port: wsPort })
      : websocketUrl("user", { local: false, origin: location.origin })
    const url = `${wsBaseUrl}?userId=${userId}`

    let ws: WebSocket
    try {
      if (generation !== connectionGenerationRef.current) return
      retireSocket()
      ws = new WebSocket(url)
    } catch (err) {
      if (generation !== connectionGenerationRef.current) return
      console.warn("[ws] WebSocket creation failed:", err)
      scheduleReconnect(generation)
      return
    }
    wsRef.current = ws
    connectStartedAtRef.current = Date.now()
    connectTimeoutRef.current = setTimeout(() => {
      if (ws !== wsRef.current || generation !== connectionGenerationRef.current) return
      ws.close()
    }, WS_CONNECTION_VALIDATION_TIMEOUT_MS)

    ws.onopen = () => {
      if (ws !== wsRef.current || generation !== connectionGenerationRef.current) return
      reconnectDelay.current = WS_RECONNECT_INIT
      ws.send(JSON.stringify({ type: "auth", token: authToken }))
    }

    ws.onmessage = (e) => {
      if (ws !== wsRef.current || generation !== connectionGenerationRef.current) return
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
          clearConnectionValidation()
          publishConnectionPhase("authenticated")
          startHeartbeat(ws, generation)
        }
        return
      }
      if (msg.type === "auth.ok") {
        if (authenticatedGenerationRef.current === generation) {
          reportDroppedFrame("duplicate-auth-ok", msg)
          return
        }
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
        runLifecycleCallback("authenticated", onAuthenticatedRef.current)
        if (isReconnect) {
          runLifecycleCallback("reconnect", () =>
            onReconnectRef.current?.({ reconnectDurationMs }))
        }
        if (requestDaemonStatusOnAuthRef.current) {
          ws.send(JSON.stringify({ type: "check_daemon_status" }))
        }
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

    ws.onclose = () => {
      if (ws !== wsRef.current) return
      const validation = connectionValidationRef.current
      if (
        validation?.ws === ws
        && validation.generation === generation
      ) {
        failConnectionValidation(ws, generation, validation.nonce)
        return
      }
      const wasAuthenticated = authenticatedGenerationRef.current === generation
      if (wasAuthenticated) {
        authenticatedGenerationRef.current = null
        disconnectedAtRef.current ??= Date.now()
        runLifecycleCallback("disconnect", onDisconnectRef.current)
      }
      stopHeartbeat()
      if (connectTimeoutRef.current !== null) { clearTimeout(connectTimeoutRef.current); connectTimeoutRef.current = null }
      publishConnectionPhase(isPageHidden() || frozenRef.current ? "suspended" : "reconnecting")
      scheduleReconnect(generation)
    }
  }, [clearConnectionValidation, failConnectionValidation, publishConnectionPhase, retireSocket, scheduleReconnect, startHeartbeat, stopHeartbeat])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  const suspendConnection = useCallback((retireAuthenticatedSocket: boolean) => {
    connectionValidationNeededRef.current = true
    suspendedAtRef.current ??= Date.now()
    clearConnectionValidation()
    stopHeartbeat()
    publishConnectionPhase("suspended")
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const generation = connectionGenerationRef.current
    const authenticated = authenticatedGenerationRef.current === generation
    if (!retireAuthenticatedSocket && authenticated) return

    connectionGenerationRef.current += 1
    abortPendingToken()
    retireSocket(retireAuthenticatedSocket)
  }, [abortPendingToken, clearConnectionValidation, publishConnectionPhase, retireSocket, stopHeartbeat])

  const trackLifecycleRecovery = useCallback((
    trigger: CommunityWsLifecycleRecoveryTrigger,
    strategy: CommunityWsLifecycleRecoveryStrategy,
    readyState: CommunityWsSocketReadyState,
    now: number,
  ) => {
    if (isPageHidden() || frozenRef.current) return
    trackCommunityWsLifecycleRecovery({
      trigger,
      strategy,
      socketReadyState: readyState,
      suspensionDuration: suspensionDurationBucket(suspendedAtRef.current, now),
    })
    suspendedAtRef.current = null
  }, [])

  const requestForegroundRecovery = useCallback((
    trigger: CommunityWsLifecycleRecoveryTrigger,
    forceValidation: boolean,
  ) => {
    if (isPageHidden()) {
      suspendConnection(false)
      return
    }

    frozenRef.current = false
    const recoveryNeeded = forceValidation || connectionValidationNeededRef.current
    if (!recoveryNeeded) return

    reconnectDelay.current = WS_RECONNECT_INIT
    if (tokenAbortRef.current) return

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
    retireSocket()
    trackLifecycleRecovery(trigger, "replace", readyState, Date.now())
    void connectRef.current?.()
  }, [retireSocket, suspendConnection, trackLifecycleRecovery, validateCurrentConnection])

  useEffect(() => {
    const mountedAt = Date.now()
    if (isPageHidden()) suspendedAtRef.current = mountedAt
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
    const onOnline = () => requestForegroundRecovery("online", false)
    const onOffline = () => { connectionValidationNeededRef.current = true }
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
    requestForegroundRecovery,
    retireSocket,
    stopHeartbeat,
    suspendConnection,
  ])

  const send = useCallback((msg: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const reconnectNow = useCallback(() => {
    clearConnectionValidation()
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    abortPendingToken()
    reconnectDelay.current = WS_RECONNECT_INIT
    retireSocket()
    if (isPageHidden() || frozenRef.current) {
      connectionGenerationRef.current += 1
      publishConnectionPhase("suspended")
      return
    }
    void connectRef.current?.()
  }, [abortPendingToken, clearConnectionValidation, publishConnectionPhase, retireSocket])

  return { send, reconnectNow }
}
