import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, sqlRun } from "@alook/test-utils"

const WS_DO_PORT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || 8789
const WS_DO_HTTP = `http://localhost:${WS_DO_PORT}`
const WS_DO_WS = `ws://localhost:${WS_DO_PORT}`

const testEmail = `e2e_ws_${randomUUID().slice(0, 8)}@test.local`
const testPassword = "TestPassword123!"
const testName = "E2E WS User"

async function wsReachable(): Promise<boolean> {
  try {
    // Any non-WS GET returns 400 ("userId required") — we just want a TCP RST-free response.
    const res = await fetch(WS_DO_HTTP, { method: "GET" })
    return res.status < 500
  } catch {
    return false
  }
}

function waitForMessage<T = unknown>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler)
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as T
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener("message", handler)
          resolve(msg)
        }
      } catch { /* ignore non-JSON */ }
    }
    ws.addEventListener("message", handler)
  })
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("close timed out")), timeoutMs)
    ws.addEventListener("close", (e) => {
      clearTimeout(timer)
      resolve(e)
    })
  })
}

function openWs(userId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_DO_WS}/?userId=${userId}`)
    const onError = () => reject(new Error("ws failed to open"))
    ws.addEventListener("open", () => {
      ws.removeEventListener("error", onError)
      resolve(ws)
    }, { once: true })
    ws.addEventListener("error", onError, { once: true })
  })
}

describe("ws (dev direct to ws-do)", () => {
  let cookie: string
  let userId: string
  let token: string
  let available = false

  beforeAll(async () => {
    available = await wsReachable()
    if (!available) return

    await signUp(testEmail, testPassword, testName)
    cookie = await signIn(testEmail, testPassword)

    const res = await sessionRequest("/api/ws/token", cookie)
    expect(res.status).toBe(200)
    const body = await res.json() as { userId: string; token: string }
    userId = body.userId
    token = body.token
  })

  afterAll(() => {
    try {
      sqlRun(`DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
      sqlRun(`DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
      sqlRun(`DELETE FROM "user" WHERE email = ?`, testEmail)
    } catch { /* ignore */ }
  })

  it("authenticates with valid token and receives broadcast", async () => {
    if (!available) return

    const ws = await openWs(userId)
    ws.send(JSON.stringify({ type: "auth", token }))

    const ack = await waitForMessage<{ type: string }>(ws, (m) => m.type === "auth.ok")
    expect(ack.type).toBe("auth.ok")

    const payload = { type: "runtime.status", daemonId: "d1", workspaceId: "w1", status: "online" }
    const recv = waitForMessage<typeof payload>(ws, (m) => m.type === "runtime.status")

    const broadcastRes = await fetch(`${WS_DO_HTTP}/broadcast/user/${userId}`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    expect(broadcastRes.status).toBe(200)

    const received = await recv
    expect(received).toEqual(payload)

    ws.close()
  })

  it("closes with 1008 on invalid token", async () => {
    if (!available) return

    const ws = await openWs(userId)
    ws.send(JSON.stringify({ type: "auth", token: "not-a-real-token" }))

    const closeEvent = await waitForClose(ws)
    expect(closeEvent.code).toBe(1008)
  })
})
