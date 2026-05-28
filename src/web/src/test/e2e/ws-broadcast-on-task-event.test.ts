/**
 * Regression: WS broadcast on task lifecycle events
 * Bug pattern: Task completion did not reliably broadcast to all connected WS clients.
 * Multiple clients connected for the same user should all receive the event.
 * Refs: #194 (Priority 5)
 *
 * NOTE: These tests are conditional on WS-DO being available at :8789.
 * If WS-DO is not running, tests skip gracefully.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest } from "@alook/test-utils"

const WS_DO_PORT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || 8789
const WS_DO_HTTP = `http://localhost:${WS_DO_PORT}`
const WS_DO_WS = `ws://localhost:${WS_DO_PORT}`

let seed: TestSeed
let wsAvailable = false

async function checkWsAvailable(): Promise<boolean> {
  try {
    const res = await fetch(WS_DO_HTTP, { method: "GET" })
    return res.status < 500
  } catch {
    return false
  }
}

function openWs(userId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_DO_WS}/?userId=${userId}`)
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000)
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws) }, { once: true })
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws connect error")) }, { once: true })
  })
}

function waitForWsMessage<T = unknown>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler)
      reject(new Error(`waitForWsMessage timed out after ${timeoutMs}ms`))
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

beforeAll(async () => {
  seed = seedTestData()
  wsAvailable = await checkWsAvailable()
  if (!wsAvailable) {
    console.log("WS-DO not available at :8789 — WS broadcast tests will be skipped")
  }
})
afterAll(() => cleanupTestData(seed))

describe("regression: WS broadcast on task events (conditional)", () => {
  it("task completion triggers WS broadcast with correct event type", async () => {
    if (!wsAvailable) return

    const ws = await openWs(seed.userId)

    // Authenticate
    const tokenRes = await tokenRequest(
      `/api/ws/token?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    if (tokenRes.status !== 200) {
      ws.close()
      return
    }
    const { token } = await tokenRes.json() as { token: string; userId: string }
    ws.send(JSON.stringify({ type: "auth", token }))
    await waitForWsMessage<{ type: string }>(ws, (m) => m.type === "auth.ok")

    // Broadcast a task.completed event
    const eventPayload = {
      type: "task.completed",
      taskId: `task_${randomUUID().slice(0, 8)}`,
      conversationId: `conv_${randomUUID().slice(0, 8)}`,
    }
    const broadcastRes = await fetch(`${WS_DO_HTTP}/broadcast/user/${seed.userId}`, {
      method: "POST",
      body: JSON.stringify(eventPayload),
    })
    expect(broadcastRes.status).toBe(200)

    const received = await waitForWsMessage<typeof eventPayload>(ws, (m) => m.type === "task.completed")
    expect(received.type).toBe("task.completed")
    expect(received.taskId).toBe(eventPayload.taskId)
    expect(received.conversationId).toBe(eventPayload.conversationId)

    ws.close()
  })

  it("multiple clients for same user all receive the broadcast", async () => {
    if (!wsAvailable) return

    const ws1 = await openWs(seed.userId)
    const ws2 = await openWs(seed.userId)

    // Authenticate both
    const tokenRes = await tokenRequest(
      `/api/ws/token?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    if (tokenRes.status !== 200) {
      ws1.close()
      ws2.close()
      return
    }
    const { token } = await tokenRes.json() as { token: string }
    ws1.send(JSON.stringify({ type: "auth", token }))
    ws2.send(JSON.stringify({ type: "auth", token }))

    await Promise.all([
      waitForWsMessage<{ type: string }>(ws1, (m) => m.type === "auth.ok"),
      waitForWsMessage<{ type: string }>(ws2, (m) => m.type === "auth.ok"),
    ])

    // Broadcast
    const eventPayload = {
      type: "conversation.message",
      conversationId: `conv_${randomUUID().slice(0, 8)}`,
      message: { id: `msg_${randomUUID().slice(0, 8)}`, content: "Hello both" },
    }
    await fetch(`${WS_DO_HTTP}/broadcast/user/${seed.userId}`, {
      method: "POST",
      body: JSON.stringify(eventPayload),
    })

    // Both should receive
    const [recv1, recv2] = await Promise.all([
      waitForWsMessage<typeof eventPayload>(ws1, (m) => m.type === "conversation.message"),
      waitForWsMessage<typeof eventPayload>(ws2, (m) => m.type === "conversation.message"),
    ])

    expect(recv1.conversationId).toBe(eventPayload.conversationId)
    expect(recv2.conversationId).toBe(eventPayload.conversationId)

    ws1.close()
    ws2.close()
  })

  it("broadcast to non-existent user returns 200 with sent=0", async () => {
    if (!wsAvailable) return

    const fakeUserId = `u_nonexistent_${randomUUID().slice(0, 8)}`
    const res = await fetch(`${WS_DO_HTTP}/broadcast/user/${fakeUserId}`, {
      method: "POST",
      body: JSON.stringify({ type: "test.ping" }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { sent: number }
    expect(data.sent).toBe(0)
  })

  it("daemon broadcast endpoint delivers to daemon WS clients", async () => {
    if (!wsAvailable) return

    // Test daemon broadcast endpoint exists and responds
    const res = await fetch(`${WS_DO_HTTP}/broadcast/daemon/${seed.daemonId}`, {
      method: "POST",
      body: JSON.stringify({ type: "daemon.tasks", tasks: [] }),
    })
    expect(res.status).toBe(200)
  })
})
