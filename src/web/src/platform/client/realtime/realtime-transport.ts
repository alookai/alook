"use client"

import { useCallback, useEffect, useState } from "react"
import {
  devWsDoPort,
  isMobile,
  isTauri,
  resolveMode,
} from "@alook/shared"
import { websocketUrl } from "./websocket-url"

const WS_RECONNECT_INIT = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_DELAY_MS) || 1_000
const WS_RECONNECT_MAX = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_MAX_DELAY_MS) || 30_000
const WS_TOKEN_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_WS_TOKEN_TIMEOUT_MS) || 10_000
const WS_CONNECT_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_WS_CONNECT_TIMEOUT_MS) || 10_000
const WS_STALE_AFTER_MS = 30_000

function defaultWsDoPort(): number {
  return Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || devWsDoPort()
}

type RawRealtimeFrameDropReason =
  | "invalid-json"
  | "non-object"
  | "missing-type"
  | "duplicate-auth-ok"
  | "pre-auth-frame"

type RealtimeFramePolicyResult<Frame, PolicyReason extends string> =
  | Readonly<{ accepted: true; frame: Frame }>
  | Readonly<{ accepted: false; reason: PolicyReason; byteCount?: number }>

export type RealtimeFramePolicy<Frame, PolicyReason extends string> = (
  input: Readonly<{
    frame: Record<string, unknown>
    rawData: string
  }>,
) => RealtimeFramePolicyResult<Frame, PolicyReason>

export type RealtimeTransportOptions<Frame, PolicyReason extends string = never> = Readonly<{
  onMessage: (frame: Frame) => void
  onReconnect?: (info: { reconnectDurationMs: number }) => void | Promise<void>
  onDisconnect?: () => void | Promise<void>
  onAuthenticated?: () => void | Promise<void>
  authenticatedFrames?: readonly object[]
  framePolicy?: RealtimeFramePolicy<Frame, PolicyReason>
  onFrameDropped?: (info: Readonly<{
    reason: RawRealtimeFrameDropReason | PolicyReason
    frame?: Record<string, unknown>
    byteCount?: number
  }>) => void
}>

export type RealtimeTransportHandle = Readonly<{
  send: (frame: object) => void
}>

function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

function isLocalBrowserMode(): boolean {
  const tauri = typeof window !== "undefined" && isTauri()
  return resolveMode({
    nodeEnv: process.env.NODE_ENV,
    hostname: typeof window !== "undefined" ? window.location.hostname : undefined,
    tauri,
    tauriPlatform: tauri ? (isMobile() ? "mobile" : "desktop") : undefined,
  }) !== "production"
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

class BrowserRealtimeTransport<Frame, PolicyReason extends string> {
  private ws: WebSocket | null = null
  private reconnectDelay = WS_RECONNECT_INIT
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private tokenAbort: AbortController | null = null
  private tokenTimeout: ReturnType<typeof setTimeout> | null = null
  private connectTimeout: ReturnType<typeof setTimeout> | null = null
  private connectStartedAt = 0
  private hasAuthenticatedBefore = false
  private authenticatedGeneration: number | null = null
  private disconnectedAt: number | null = null
  private lastMessageAt = 0
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private livenessInterval: ReturnType<typeof setInterval> | null = null
  private connectionGeneration = 0

  constructor(
    private options: RealtimeTransportOptions<Frame, PolicyReason>,
  ) {}

  updateOptions(options: RealtimeTransportOptions<Frame, PolicyReason>) {
    this.options = options
  }

  start() {
    void this.connect()
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.resumeConnection)
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", this.resumeConnection)
      window.addEventListener("online", this.resumeConnection)
    }
  }

  stop() {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.resumeConnection)
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pageshow", this.resumeConnection)
      window.removeEventListener("online", this.resumeConnection)
    }
    this.connectionGeneration += 1
    this.tokenAbort?.abort()
    this.tokenAbort = null
    this.clearReconnectTimer()
    this.clearTokenTimeout()
    this.clearConnectTimeout()
    this.clearLivenessTimers()
    this.retireSocket(false)
  }

  send(frame: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame))
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearTokenTimeout() {
    if (this.tokenTimeout !== null) {
      clearTimeout(this.tokenTimeout)
      this.tokenTimeout = null
    }
  }

  private clearConnectTimeout() {
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout)
      this.connectTimeout = null
    }
  }

  private clearLivenessTimers() {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
    if (this.livenessInterval !== null) {
      clearInterval(this.livenessInterval)
      this.livenessInterval = null
    }
  }

  private reportDroppedFrame(
    reason: RawRealtimeFrameDropReason | PolicyReason,
    frame?: Record<string, unknown>,
    byteCount?: number,
  ) {
    try {
      this.options.onFrameDropped?.({ reason, frame, byteCount })
    } catch {
      console.warn("[ws] frame-drop callback threw", { reason })
    }
  }

  private retireSocket(reportDisconnect = true) {
    const ws = this.ws
    this.ws = null
    if (reportDisconnect && this.authenticatedGeneration !== null) {
      this.authenticatedGeneration = null
      this.disconnectedAt ??= Date.now()
      runLifecycleCallback("disconnect", this.options.onDisconnect)
    }
    this.clearLivenessTimers()
    this.clearConnectTimeout()
    ws?.close()
  }

  private scheduleReconnect(generation: number) {
    if (generation !== this.connectionGeneration || isPageHidden()) return
    this.clearReconnectTimer()
    const delay = Math.min(this.reconnectDelay, WS_RECONNECT_MAX)
    this.reconnectDelay = Math.min(delay * 2, WS_RECONNECT_MAX)
    this.reconnectTimer = setTimeout(() => {
      if (generation !== this.connectionGeneration) return
      void this.connect()
    }, delay + Math.random() * 500)
  }

  private connect = async () => {
    if (isPageHidden()) return
    const generation = this.connectionGeneration + 1
    this.connectionGeneration = generation
    this.clearReconnectTimer()
    this.tokenAbort?.abort()
    const tokenController = new AbortController()
    this.tokenAbort = tokenController
    let tokenTimedOut = false
    this.tokenTimeout = setTimeout(() => {
      tokenTimedOut = true
      tokenController.abort()
    }, WS_TOKEN_TIMEOUT_MS)

    let userId: string
    let authToken: string
    let wsPort = defaultWsDoPort()
    try {
      const response = await fetch("/api/ws/token", { signal: tokenController.signal })
      if (!response.ok) {
        if (generation !== this.connectionGeneration) return
        console.warn("[ws] token fetch failed:", response.status)
        this.scheduleReconnect(generation)
        return
      }
      const body = await response.json() as {
        userId: string
        token: string
        wsPort?: number
      }
      if (generation !== this.connectionGeneration) return
      userId = body.userId
      authToken = body.token
      if (body.wsPort) wsPort = body.wsPort
    } catch (error) {
      if (generation !== this.connectionGeneration) return
      if (tokenController.signal.aborted && !tokenTimedOut) return
      console.warn("[ws] token fetch error:", error)
      this.scheduleReconnect(generation)
      return
    } finally {
      if (this.tokenAbort === tokenController) {
        this.clearTokenTimeout()
        this.tokenAbort = null
      }
    }

    const wsBaseUrl = isLocalBrowserMode()
      ? websocketUrl("user", { local: true, port: wsPort })
      : websocketUrl("user", { local: false, origin: location.origin })
    const url = `${wsBaseUrl}?userId=${userId}`

    let ws: WebSocket
    try {
      if (generation !== this.connectionGeneration) return
      this.retireSocket()
      ws = new WebSocket(url)
    } catch (error) {
      if (generation !== this.connectionGeneration) return
      console.warn("[ws] WebSocket creation failed:", error)
      this.scheduleReconnect(generation)
      return
    }
    this.ws = ws
    this.connectStartedAt = Date.now()
    this.connectTimeout = setTimeout(() => {
      if (ws !== this.ws || generation !== this.connectionGeneration) return
      ws.close()
    }, WS_CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (ws !== this.ws || generation !== this.connectionGeneration) return
      this.reconnectDelay = WS_RECONNECT_INIT
      ws.send(JSON.stringify({ type: "auth", token: authToken }))
      this.lastMessageAt = Date.now()
      this.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping")
      }, 25_000)
      this.livenessInterval = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 30_000) ws.close()
      }, 5_000)
    }

    ws.onmessage = (event) => {
      if (ws !== this.ws || generation !== this.connectionGeneration) return
      this.lastMessageAt = Date.now()
      if (typeof event.data !== "string") {
        this.reportDroppedFrame("invalid-json")
        return
      }
      if (event.data === "pong") return

      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        this.reportDroppedFrame("invalid-json")
        return
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.reportDroppedFrame("non-object")
        return
      }
      const frame = parsed as Record<string, unknown>
      if (typeof frame.type !== "string" || frame.type.length === 0) {
        this.reportDroppedFrame("missing-type", frame)
        return
      }
      if (frame.type === "auth.ok") {
        if (this.authenticatedGeneration === generation) {
          this.reportDroppedFrame("duplicate-auth-ok", frame)
          return
        }
        this.authenticatedGeneration = generation
        this.clearConnectTimeout()
        const isReconnect = this.hasAuthenticatedBefore
        this.hasAuthenticatedBefore = true
        const reconnectDurationMs = this.disconnectedAt === null
          ? 0
          : Math.max(0, Date.now() - this.disconnectedAt)
        this.disconnectedAt = null
        const options = this.options
        runLifecycleCallback("authenticated", options.onAuthenticated)
        if (isReconnect) {
          runLifecycleCallback("reconnect", () =>
            options.onReconnect?.({ reconnectDurationMs }))
        }
        for (const authenticatedFrame of options.authenticatedFrames ?? []) {
          ws.send(JSON.stringify(authenticatedFrame))
        }
        return
      }
      if (this.authenticatedGeneration !== generation) {
        this.reportDroppedFrame("pre-auth-frame", frame)
        return
      }

      const options = this.options
      const policyResult = options.framePolicy?.({ frame, rawData: event.data })
      if (policyResult && !policyResult.accepted) {
        this.reportDroppedFrame(
          policyResult.reason,
          frame,
          policyResult.byteCount,
        )
        return
      }
      const acceptedFrame = policyResult?.frame ?? frame as Frame
      try {
        options.onMessage(acceptedFrame)
      } catch {
        console.warn("[ws] message callback threw", {
          type: /^[a-z0-9_.:-]+$/i.test(frame.type) && frame.type.length <= 96
            ? frame.type
            : "unknown",
        })
      }
    }

    ws.onerror = () => {}
    ws.onclose = () => {
      if (ws !== this.ws) return
      const wasAuthenticated = this.authenticatedGeneration === generation
      if (wasAuthenticated) {
        this.authenticatedGeneration = null
        this.disconnectedAt ??= Date.now()
        runLifecycleCallback("disconnect", this.options.onDisconnect)
      }
      this.clearLivenessTimers()
      this.clearConnectTimeout()
      this.scheduleReconnect(generation)
    }
  }

  private resumeConnection = () => {
    if (isPageHidden()) {
      this.clearReconnectTimer()
      if (this.tokenAbort) {
        this.connectionGeneration += 1
        this.tokenAbort.abort()
        this.tokenAbort = null
        this.clearTokenTimeout()
      }
      return
    }

    this.reconnectDelay = WS_RECONNECT_INIT
    if (this.tokenAbort) return

    const generation = this.connectionGeneration
    const authenticated = this.authenticatedGeneration === generation
    const fresh = authenticated
      && this.ws?.readyState === WebSocket.OPEN
      && Date.now() - this.lastMessageAt <= WS_STALE_AFTER_MS
    const connecting = this.ws?.readyState === WebSocket.CONNECTING
      && Date.now() - this.connectStartedAt <= WS_CONNECT_TIMEOUT_MS
    if (fresh || connecting) return

    this.connectionGeneration += 1
    this.clearReconnectTimer()
    this.retireSocket()
    void this.connect()
  }
}

export function useRealtimeTransport<Frame, PolicyReason extends string = never>(
  options: RealtimeTransportOptions<Frame, PolicyReason>,
): RealtimeTransportHandle {
  const [transport] = useState(() =>
    new BrowserRealtimeTransport<Frame, PolicyReason>(options))

  useEffect(() => {
    transport.updateOptions(options)
  }, [options, transport])

  useEffect(() => {
    transport.start()
    return () => transport.stop()
  }, [transport])

  const send = useCallback((frame: object) => {
    transport.send(frame)
  }, [transport])

  return { send }
}
