import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, sqlQuery, postEmail } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => { seed = seedTestData() })
afterAll(() => cleanupTestData(seed))

async function waitForEmail(subject: string): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const rows = sqlQuery<Record<string, unknown>>(
      "SELECT * FROM emails WHERE agent_id = ? AND workspace_id = ? AND subject = ?",
      seed.agentId, seed.workspaceId, subject,
    )
    if (rows.length > 0) return rows[0]
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

describe("cross-service: inbound email storage after legacy task retirement", () => {
  it.each([true, false])("stores email with whitelist=%s without creating a legacy task or conversation", async whitelisted => {
    const from = whitelisted ? `${seed.userId}@test.local` : "unknown-sender@external.test"
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = `E2E email ${randomUUID()}`
    const response = await postEmail(from, to, subject, "Cross-service storage test")
    expect(response.status).toBe(whitelisted ? 200 : 400)

    const email = await waitForEmail(subject)
    expect(email).toMatchObject({
      agent_id: seed.agentId,
      workspace_id: seed.workspaceId,
      from_email: from,
      to_email: to,
      subject,
      is_whitelisted: whitelisted ? 1 : 0,
      direction: "inbound",
    })
    expect(email?.r2_key).toBeTruthy()
    expect(sqlQuery("SELECT id FROM agent_task_queue WHERE agent_id = ? AND workspace_id = ?", seed.agentId, seed.workspaceId)).toHaveLength(0)
    expect(sqlQuery("SELECT id FROM conversation WHERE workspace_id = ?", seed.workspaceId)).toHaveLength(0)
  })
})
