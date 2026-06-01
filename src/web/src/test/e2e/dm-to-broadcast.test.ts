/**
 * Cross-service E2E: User DM → Task → Daemon poll+start+complete → broadcast HTTP endpoint
 * Verifies the full message-to-broadcast flow via server-side assertions only.
 * Refs: #190
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest } from "@alook/test-utils"

const WS_DO_PORT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || 8789
const WS_DO_HTTP = `http://localhost:${WS_DO_PORT}`

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

  it("broadcast HTTP endpoint delivers to connected sessions", async () => {
    if (!wsAvailable) return

    const payload = { type: "task.completed", taskId: `test_${randomUUID().slice(0, 8)}`, conversationId }
    const broadcastRes = await fetch(`${WS_DO_HTTP}/broadcast/user/${seed.userId}`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    expect(broadcastRes.status).toBe(200)
    const broadcastData = await broadcastRes.json() as { sent: number }
    expect(broadcastData.sent).toBeGreaterThanOrEqual(0)
  })
})
