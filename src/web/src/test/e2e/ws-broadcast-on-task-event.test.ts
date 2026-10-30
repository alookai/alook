import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { DEV_WS_DO_URL } from "@alook/shared"
import { seedTestData, cleanupTestData, type TestSeed } from "@alook/test-utils"

let seed: TestSeed
let wsAvailable = false

async function checkWsAvailable(): Promise<boolean> {
  try {
    const res = await fetch(DEV_WS_DO_URL, { method: "GET" })
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

describe("WS user broadcast and retired daemon endpoint", () => {
  it("current user email notification broadcast returns 200", async () => {
    if (!wsAvailable) return

    const eventPayload = {
      type: "email.received",
      agentId: seed.agentId,
    }
    const broadcastRes = await fetch(`${DEV_WS_DO_URL}/broadcast/user/${seed.userId}`, {
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
    const res = await fetch(`${DEV_WS_DO_URL}/broadcast/user/${fakeUserId}`, {
      method: "POST",
      body: JSON.stringify({ type: "test.ping" }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { sent: number }
    expect(data.sent).toBe(0)
  })

  it("retired daemon broadcast cannot deliver legacy tasks", async () => {
    if (!wsAvailable) return

    const res = await fetch(`${DEV_WS_DO_URL}/broadcast/daemon/${seed.daemonId}`, {
      method: "POST",
      body: JSON.stringify({ type: "daemon.tasks", tasks: [] }),
    })
    expect(res.status).toBe(400)
  })
})
