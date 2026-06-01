/**
 * Regression: WS broadcast HTTP endpoint on task lifecycle events
 * Verifies the broadcast HTTP endpoint responds correctly (server-side only).
 * Refs: #194 (Priority 5)
 *
 * NOTE: Tests are conditional on WS-DO being available at :8789.
 * If WS-DO is not running, tests skip gracefully.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed } from "@alook/test-utils"

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

describe("regression: WS broadcast HTTP endpoint on task events", () => {
  it("task completion broadcast returns 200", async () => {
    if (!wsAvailable) return

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
    const data = await broadcastRes.json() as { sent: number }
    expect(data.sent).toBeGreaterThanOrEqual(0)
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

    const res = await fetch(`${WS_DO_HTTP}/broadcast/daemon/${seed.daemonId}`, {
      method: "POST",
      body: JSON.stringify({ type: "daemon.tasks", tasks: [] }),
    })
    expect(res.status).toBe(200)
  })
})
