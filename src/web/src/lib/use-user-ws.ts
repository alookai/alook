"use client"
import { useEffect, useRef, useCallback } from "react"
import type { WsMessage } from "@alook/shared"
import { isLocalMode } from "@/lib/utils"

const isLocal = isLocalMode()
const WS_DO_PORT_DEFAULT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || 8789
const WS_RECONNECT_INIT = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_DELAY_MS) || 1000
const WS_RECONNECT_MAX = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_MAX_DELAY_MS) || 30_000

export function useUserWs(onMessage: (msg: WsMessage) => void, options?: { onReconnect?: () => void }) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(WS_RECONNECT_INIT)
  const onMessageRef = useRef(onMessage)
  const onReconnectRef = useRef(options?.onReconnect)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasConnectedBeforeRef = useRef(false)
  const lastMessageAtRef = useRef(0)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const livenessIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])

  useEffect(() => {
    onReconnectRef.current = options?.onReconnect
  }, [options?.onReconnect])

  const connectRef = useRef<(() => Promise<void>) | null>(null)

  const scheduleReconnect = useCallback(() => {
    const delay = Math.min(reconnectDelay.current, WS_RECONNECT_MAX)
    reconnectDelay.current = Math.min(delay * 2, WS_RECONNECT_MAX)
    reconnectTimerRef.current = setTimeout(() => {
      void connectRef.current?.()
    }, delay + Math.random() * 500)
  }, [])

  const connect = useCallback(async () => {
    let userId: string
    let authToken: string
    let wsPort: number = WS_DO_PORT_DEFAULT
    try {
      const res = await fetch("/api/ws/token")
      if (!res.ok) {
        console.warn("[ws] token fetch failed:", res.status)
        scheduleReconnect()
        return
      }
      const body = await res.json() as { userId: string; token: string; wsPort?: number }
      userId = body.userId
      authToken = body.token
      if (body.wsPort) wsPort = body.wsPort
    } catch (err) {
      console.warn("[ws] token fetch error:", err)
      scheduleReconnect()
      return
    }

    const url = isLocal
      ? `ws://localhost:${wsPort}/?userId=${userId}`
      : `${location.origin.replace("http", "ws")}/api/ws/user?userId=${userId}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      console.warn("[ws] WebSocket creation failed:", err)
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      reconnectDelay.current = WS_RECONNECT_INIT
      ws.send(JSON.stringify({ type: "auth", token: authToken }))

      if (hasConnectedBeforeRef.current) {
        onReconnectRef.current?.()
      }
      hasConnectedBeforeRef.current = true

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
      lastMessageAtRef.current = Date.now()
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "auth.ok") {
          ws.send(JSON.stringify({ type: "check_daemon_status" }))
          return
        }
        onMessageRef.current(msg as WsMessage)
      } catch {}
    }

    ws.onerror = () => {}

    ws.onclose = () => {
      if (ws !== wsRef.current) return
      if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null }
      if (livenessIntervalRef.current) { clearInterval(livenessIntervalRef.current); livenessIntervalRef.current = null }
      scheduleReconnect()
    }
  }, [scheduleReconnect])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  useEffect(() => {
    connect()
    return () => {
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
}
