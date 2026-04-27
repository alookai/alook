import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { sql, sqlQuery } from "../helpers/db"
import { postEmail } from "../helpers/email"
import { randomUUID } from "crypto"

let seed: TestSeed
let seedOther: TestSeed

function nanoid() {
  return randomUUID().replace(/-/g, "").slice(0, 21)
}

beforeAll(() => {
  seed = seedTestData()
  seedOther = seedTestData()
})
afterAll(() => {
  cleanupTestData(seed)
  cleanupTestData(seedOther)
})

describe("whitelist bypass for same-workspace agents", () => {
  async function waitForEmail(
    agentId: string,
    fromEmail: string,
    maxMs = 5000,
  ): Promise<Record<string, unknown> | null> {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      const rows = sqlQuery<Record<string, unknown>>(
        `SELECT * FROM emails WHERE agent_id = '${agentId}' AND from_email = '${fromEmail}' ORDER BY created_at DESC LIMIT 1`,
      )
      if (rows.length > 0) return rows[0]
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  }

  it("same-workspace agent email is treated as whitelisted (bypass)", async () => {
    const siblingAgentId = `ag_${nanoid()}`
    const siblingHandle = `e2e-sib-${nanoid()}`
    const now = new Date().toISOString()
    sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES ('${siblingAgentId}', '${seed.workspaceId}', 'Sibling Agent', '${seed.runtimeId}', '${siblingHandle}', '${seed.userId}', '${now}', '${now}')`)

    try {
      const from = `${siblingHandle}@alook.ai`
      const to = `${seed.agentEmailHandle}@alook.ai`

      const res = await postEmail(from, to, "E2E bypass test", "Hello from sibling")
      expect(res.status).toBe(200)

      const row = await waitForEmail(seed.agentId, from)
      expect(row).not.toBeNull()
      expect(row!.is_whitelisted).toBe(1)
    } finally {
      sql(`DELETE FROM agent WHERE id = '${siblingAgentId}' AND workspace_id = '${seed.workspaceId}'`)
    }
  })

  it("agent emailing itself is treated as whitelisted", async () => {
    const from = `${seed.agentEmailHandle}@alook.ai`
    const to = `${seed.agentEmailHandle}@alook.ai`

    const res = await postEmail(from, to, "E2E self-email test", "Hello self")
    expect(res.status).toBe(200)

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(1)
  })

  it("different-workspace agent email is NOT treated as whitelisted", async () => {
    const from = `${seedOther.agentEmailHandle}@alook.ai`
    const to = `${seed.agentEmailHandle}@alook.ai`

    await postEmail(from, to, "E2E cross-workspace test", "Cross workspace")

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(0)
  })

  it("@alook.ai email with nonexistent handle is NOT whitelisted", async () => {
    const from = `nonexistent-handle-${nanoid()}@alook.ai`
    const to = `${seed.agentEmailHandle}@alook.ai`

    await postEmail(from, to, "E2E nonexistent handle test", "Ghost agent")

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(0)
  })

  it("regular whitelist entries still work (existing behavior)", async () => {
    const from = `${seed.userId}@test.local`
    const to = `${seed.agentEmailHandle}@alook.ai`

    const res = await postEmail(from, to, "E2E regular whitelist test", "Regular whitelisted")
    expect(res.status).toBe(200)

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(1)
  })

  it("non-whitelisted non-agent email is rejected (existing behavior)", async () => {
    const from = "random-stranger@gmail.com"
    const to = `${seed.agentEmailHandle}@alook.ai`

    await postEmail(from, to, "E2E stranger test", "Stranger")

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(0)
  })

  it("sender that is both whitelisted AND same-workspace agent is whitelisted", async () => {
    const siblingAgentId = `ag_${nanoid()}`
    const siblingHandle = `e2e-both-${nanoid()}`
    const now = new Date().toISOString()
    const wlId = `wl_${nanoid()}`
    sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES ('${siblingAgentId}', '${seed.workspaceId}', 'Both Agent', '${seed.runtimeId}', '${siblingHandle}', '${seed.userId}', '${now}', '${now}')`)
    sql(`INSERT INTO agent_whitelist (id, agent_id, workspace_id, email, created_at) VALUES ('${wlId}', '${seed.agentId}', '${seed.workspaceId}', '${siblingHandle}@alook.ai', '${now}')`)

    try {
      const from = `${siblingHandle}@alook.ai`
      const to = `${seed.agentEmailHandle}@alook.ai`

      const res = await postEmail(from, to, "E2E both paths test", "Both paths")
      expect(res.status).toBe(200)

      const row = await waitForEmail(seed.agentId, from)
      expect(row).not.toBeNull()
      expect(row!.is_whitelisted).toBe(1)
    } finally {
      sql(`DELETE FROM agent_whitelist WHERE id = '${wlId}'`)
      sql(`DELETE FROM agent WHERE id = '${siblingAgentId}' AND workspace_id = '${seed.workspaceId}'`)
    }
  })
})
