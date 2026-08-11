"use client"
import { useEffect, useRef, useCallback } from "react"
import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  isCommunityEventCandidate,
  isCommunityEventType,
  type WsMessage,
} from "@alook/shared"
import {
  trackCommunityWsFrameDropped,
  type CommunityWsFrameDropReason,
} from "@/lib/analytics"
import { isLocalMode, WS_DO_PORT_DEFAULT } from "@/lib/utils"

const isLocal = isLocalMode()
const WS_RECONNECT_INIT = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_DELAY_MS) || 1000
const WS_RECONNECT_MAX = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_MAX_DELAY_MS) || 30_000

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

export type UseUserWsOptions = {
  onReconnect?: (info: { reconnectDurationMs: number }) => void | Promise<void>
  onDisconnect?: () => void | Promise<void>
  onAuthenticated?: () => void | Promise<void>
  requestDaemonStatusOnAuth?: boolean
}

function runLifecycleCallback(
  name: "authenticated" | "disconnect" | "reconnect",
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
  const rawVersion = value?.contractVersion
  const contractVersion = typeof rawVersion === "number" && Number.isSafeInteger(rawVersion)
    ? rawVersion
    : undefined
  const metadata = {
    reason,
    type,
    ...(contractVersion === undefined ? {} : { contractVersion }),
    ...(byteCount === undefined ? {} : { byteCount }),
  }
  console.warn("[ws] frame dropped", { event: "community_ws_frame_dropped", ...metadata })
  trackCommunityWsFrameDropped(metadata)
}

export function useUserWs(
  onMessage: (msg: WsMessageIncoming) => void,
  options?: UseUserWsOptions,
): { send: (msg: object) => void } {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(WS_RECONNECT_INIT)
  const onMessageRef = useRef(onMessage)
  const onReconnectRef = useRef(options?.onReconnect)
  const onDisconnectRef = useRef(options?.onDisconnect)
  const onAuthenticatedRef = useRef(options?.onAuthenticated)
  const requestDaemonStatusOnAuthRef = useRef(options?.requestDaemonStatusOnAuth ?? true)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasAuthenticatedBeforeRef = useRef(false)
  const authenticatedGenerationRef = useRef<number | null>(null)
  const disconnectedAtRef = useRef<number | null>(null)
  const lastMessageAtRef = useRef(0)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const livenessIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const connectionGenerationRef = useRef(0)

  useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])

  useEffect(() => {
    onReconnectRef.current = options?.onReconnect
  }, [options?.onReconnect])

  useEffect(() => {
    onDisconnectRef.current = options?.onDisconnect
    onAuthenticatedRef.current = options?.onAuthenticated
  }, [options?.onAuthenticated, options?.onDisconnect])

  useEffect(() => {
    requestDaemonStatusOnAuthRef.current = options?.requestDaemonStatusOnAuth ?? true
  }, [options?.requestDaemonStatusOnAuth])

  const connectRef = useRef<(() => Promise<void>) | null>(null)

  const scheduleReconnect = useCallback((generation: number) => {
    if (generation !== connectionGenerationRef.current) return
    const delay = Math.min(reconnectDelay.current, WS_RECONNECT_MAX)
    reconnectDelay.current = Math.min(delay * 2, WS_RECONNECT_MAX)
    reconnectTimerRef.current = setTimeout(() => {
      if (generation !== connectionGenerationRef.current) return
      void connectRef.current?.()
    }, delay + Math.random() * 500)
  }, [])

  const connect = useCallback(async () => {
    const generation = connectionGenerationRef.current + 1
    connectionGenerationRef.current = generation
    let userId: string
    let authToken: string
    let wsPort: number = WS_DO_PORT_DEFAULT
    try {
      const res = await fetch("/api/ws/token")
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
      console.warn("[ws] token fetch error:", err)
      scheduleReconnect(generation)
      return
    }

    const url = isLocal
      ? `ws://localhost:${wsPort}/?userId=${userId}`
      : `${location.origin.replace("http", "ws")}/api/ws/user?userId=${userId}`

    let ws: WebSocket
    try {
      if (generation !== connectionGenerationRef.current) return
      ws = new WebSocket(url)
    } catch (err) {
      if (generation !== connectionGenerationRef.current) return
      console.warn("[ws] WebSocket creation failed:", err)
      scheduleReconnect(generation)
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      if (ws !== wsRef.current || generation !== connectionGenerationRef.current) return
      reconnectDelay.current = WS_RECONNECT_INIT
      ws.send(JSON.stringify({ type: "auth", token: authToken }))

      lastMessageAtRef.current = Date.now()
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("ping")
        }
      }, 25_000)
      livenessIntervalRef.current = setInterval(() => {
        if (Date.now() - lastMessageAtRef.current > 30_000) {
          ws.close()
        }
      }, 5_000)
    }

    ws.onmessage = (e) => {
      if (ws !== wsRef.current || generation !== connectionGenerationRef.current) return
      lastMessageAtRef.current = Date.now()
      if (typeof e.data !== "string") {
        reportDroppedFrame("invalid-json")
        return
      }
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
      if (msg.type === "auth.ok") {
        if (authenticatedGenerationRef.current === generation) {
          reportDroppedFrame("duplicate-auth-ok", msg)
          return
        }
        authenticatedGenerationRef.current = generation
        const isReconnect = hasAuthenticatedBeforeRef.current
        hasAuthenticatedBeforeRef.current = true
        const reconnectDurationMs = disconnectedAtRef.current === null
          ? 0
          : Math.max(0, Date.now() - disconnectedAtRef.current)
        disconnectedAtRef.current = null
        runLifecycleCallback("authenticated", onAuthenticatedRef.current)
        if (isReconnect) {
          runLifecycleCallback("reconnect", () =>
            onReconnectRef.current?.({ reconnectDurationMs }))
        }
        if (requestDaemonStatusOnAuthRef.current) {
          ws.send(JSON.stringify({ type: "check_daemon_status" }))
        }
        return
      }
      if (authenticatedGenerationRef.current !== generation) {
        reportDroppedFrame("pre-auth-frame", msg)
        return
      }
      if (isCommunityEventCandidate(msg)) {
        const byteCount = new TextEncoder().encode(e.data).byteLength
        if (byteCount > COMMUNITY_BROWSER_EVENT_MAX_BYTES) {
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
      const wasAuthenticated = authenticatedGenerationRef.current === generation
      if (wasAuthenticated) {
        authenticatedGenerationRef.current = null
        disconnectedAtRef.current ??= Date.now()
        runLifecycleCallback("disconnect", onDisconnectRef.current)
      }
      if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
      if (livenessIntervalRef.current) { clearInterval(livenessIntervalRef.current); livenessIntervalRef.current = null }
      scheduleReconnect(generation)
    }
  }, [scheduleReconnect])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  useEffect(() => {
    connect()
    return () => {
      connectionGenerationRef.current += 1
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
      if (livenessIntervalRef.current) { clearInterval(livenessIntervalRef.current); livenessIntervalRef.current = null }
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [connect])

  const send = useCallback((msg: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  return { send }
}
