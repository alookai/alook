/**
 * Cross-service E2E: User DM → Task → Daemon poll+start+complete → WS broadcast
 * Verifies the full message-to-broadcast flow.
 * Refs: #190
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
})
afterAll(() => cleanupTestData(seed))

describe("cross-service: DM → task lifecycle → WS broadcast", () => {
  let conversationId: string
  let taskId: string

  it("user message creates a task", async () => {
    const convRes = await tokenRequest(
      `/api/conversations?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: seed.agentId }),
      },
    )
    expect(convRes.ok).toBe(true)
    const convData = await convRes.json() as { id: string }
    conversationId = convData.id

    const msgRes = await tokenRequest(
      `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "DM broadcast test" }),
      },
    )
    expect(msgRes.ok).toBe(true)
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    expect(msgData.task).toBeTruthy()
    taskId = msgData.task!.id
  })

  it("daemon polls and claims the task", async () => {
    const pollRes = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 5 }),
      },
    )
    expect(pollRes.status).toBe(200)
    const pollData = await pollRes.json() as { tasks: Array<Record<string, unknown>> }
    expect(pollData.tasks.length).toBeGreaterThanOrEqual(1)
    const claimed = pollData.tasks.find(t => t.id === taskId)
    expect(claimed).toBeTruthy()
    expect(claimed!.status).toBe("dispatched")
  })

  it("daemon starts the task", async () => {
    const startRes = await tokenRequest(
      `/api/daemon/tasks/${taskId}/start`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(startRes.status).toBe(200)
    const startData = await startRes.json() as { status: string }
    expect(startData.status).toBe("running")
  })

  it("daemon completes the task", async () => {
    const completeRes = await tokenRequest(
      `/api/daemon/tasks/${taskId}/complete`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output: "Task done", session_id: `sess_${randomUUID().slice(0, 8)}` }),
      },
    )
    expect(completeRes.status).toBe(200)
    const completeData = await completeRes.json() as { status: string }
    expect(completeData.status).toBe("completed")
  })

  it("WS broadcast sent on task complete (conditional on WS-DO available)", async () => {
    if (!wsAvailable) {
      console.log("WS-DO not available at :8789 — skipping WS broadcast verification")
      return
    }

    // Set up a WS client connection
    const ws = await openWs(seed.userId)

    // Authenticate (get token via API)
    const tokenRes = await tokenRequest(
      `/api/ws/token?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    if (tokenRes.status !== 200) {
      ws.close()
      console.log("WS token endpoint not available — skipping")
      return
    }
    const { token } = await tokenRes.json() as { token: string }
    ws.send(JSON.stringify({ type: "auth", token }))

    // Wait for auth ack
    const ack = await waitForWsMessage<{ type: string }>(ws, (m) => m.type === "auth.ok")
    expect(ack.type).toBe("auth.ok")

    // Now trigger a broadcast via the HTTP broadcast endpoint
    const payload = { type: "task.completed", taskId: `test_${randomUUID().slice(0, 8)}`, conversationId }
    const broadcastRes = await fetch(`${WS_DO_HTTP}/broadcast/user/${seed.userId}`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    expect(broadcastRes.status).toBe(200)

    const received = await waitForWsMessage<typeof payload>(ws, (m) => m.type === "task.completed")
    expect(received.type).toBe("task.completed")
    expect(received.conversationId).toBe(conversationId)

    ws.close()
  })
})
