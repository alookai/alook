"use client"
import { useEffect, useRef, useCallback } from "react"
import type { WsMessage } from "@alook/shared"

const isDev = process.env.NODE_ENV === "development"
const WS_DO_PORT = 8789

export function useUserWs(onMessage: (msg: WsMessage) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelay = useRef(1000)

  const connect = useCallback(async () => {
    let url: string
    let authToken: string | null = null

    if (isDev) {
      // Dev: connect directly to ws-do worker, authenticate via auth message
      try {
        const res = await fetch("/api/ws/token")
        if (!res.ok) return
        const { userId, token } = await res.json() as { userId: string; token: string }
        url = `ws://localhost:${WS_DO_PORT}/?userId=${userId}`
        authToken = token
      } catch {
        return
      }
    } else {
      // Production: go through Next.js API route (service binding handles WS upgrade)
      url = `${location.origin.replace("http", "ws")}/api/ws/user`
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      reconnectDelay.current = 1000
      if (authToken) {
        ws.send(JSON.stringify({ type: "auth", token: authToken }))
      }
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "auth.ok") return
        onMessage(msg as WsMessage)
      } catch {}
    }

    ws.onerror = () => {}

    ws.onclose = () => {
      const delay = Math.min(reconnectDelay.current, 30_000)
      reconnectDelay.current = Math.min(delay * 2, 30_000)
      setTimeout(connect, delay + Math.random() * 500)
    }
  }, [onMessage])

  useEffect(() => {
    connect()
    return () => { wsRef.current?.close() }
  }, [connect])
}
