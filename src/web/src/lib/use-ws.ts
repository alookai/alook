"use client"
import { useEffect, useRef, useCallback } from "react"
import type { WsMessage } from "@alook/shared"
import { isLocalMode } from "@/lib/utils"

const isDev = isLocalMode()
const WS_DO_PORT_DEFAULT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || 8789
const WS_RECONNECT_INIT = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_DELAY_MS) || 1000
const WS_RECONNECT_MAX = Number(process.env.NEXT_PUBLIC_WS_RECONNECT_MAX_DELAY_MS) || 30_000

export function useAgentWs(agentId: string, onMessage: (msg: WsMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(WS_RECONNECT_INIT)
  const onMessageRef = useRef(onMessage)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])

  const connectRef = useRef<(() => Promise<void>) | null>(null)

  const connect = useCallback(async () => {
    let userId: string
    let authToken: string
    let wsPort: number = WS_DO_PORT_DEFAULT
    try {
      const res = await fetch("/api/ws/token")
      if (!res.ok) return
      const body = await res.json() as { userId: string; token: string; wsPort?: number }
      userId = body.userId
      authToken = body.token
      if (body.wsPort) wsPort = body.wsPort
    } catch {
      return
    }

    const url = isDev
      ? `ws://localhost:${wsPort}/?userId=${userId}&agentId=${agentId}`
      : `${location.origin.replace("http", "ws")}/api/ws?userId=${userId}&agentId=${agentId}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      reconnectDelay.current = WS_RECONNECT_INIT
      ws.send(JSON.stringify({ type: "auth", token: authToken }))
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "auth.ok") return
        onMessageRef.current(msg as WsMessage)
      } catch {}
    }

    ws.onerror = () => {}

    ws.onclose = () => {
      if (ws !== wsRef.current) return

      const delay = Math.min(reconnectDelay.current, WS_RECONNECT_MAX)
      reconnectDelay.current = Math.min(delay * 2, WS_RECONNECT_MAX)
      reconnectTimerRef.current = setTimeout(() => {
        void connectRef.current?.()
      }, delay + Math.random() * 500)
    }
  }, [agentId])

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
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [connect])
}
