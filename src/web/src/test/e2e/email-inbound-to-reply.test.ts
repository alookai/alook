/**
 * Cross-service E2E: Email Worker → App → Task Created
 * Verifies the full inbound email flow across services.
 * Refs: #190
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlQuery, postEmail } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

async function waitForTask(
  agentId: string,
  workspaceId: string,
  type: string,
  promptContains?: string,
  maxMs = 8000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now()
  const promptFilter = promptContains
    ? ` AND prompt LIKE '%${promptContains}%'`
    : ""
  while (Date.now() - start < maxMs) {
    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM agent_task_queue WHERE agent_id = '${agentId}' AND workspace_id = '${workspaceId}' AND type = '${type}'${promptFilter} ORDER BY created_at DESC LIMIT 1`,
    )
    if (rows.length > 0) return rows[0]
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

describe("cross-service: email inbound → task creation", () => {
  it("whitelisted email via email-worker → app notify → task created with type=email_notification", async () => {
    const from = `${seed.userId}@test.local`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = `E2E cross-service ${randomUUID().slice(0, 8)}`

    const emailRes = await postEmail(from, to, subject, "Cross-service test body")
    expect(emailRes.status).toBe(200)

    const task = await waitForTask(seed.agentId, seed.workspaceId, "email_notification", subject)
    expect(task).not.toBeNull()
    expect(task!.type).toBe("email_notification")
    expect(task!.prompt).toContain(from)
    expect(task!.prompt).toContain(subject)
    expect(task!.status).toMatch(/queued|dispatched/)
  })

  it("task has correct metadata: conversation_id set, context_key matches conversation", async () => {
    const from = `${seed.userId}@test.local`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = `E2E metadata ${randomUUID().slice(0, 8)}`

    await postEmail(from, to, subject, "Metadata test")

    const task = await waitForTask(seed.agentId, seed.workspaceId, "email_notification", subject)
    expect(task).not.toBeNull()
    expect(task!.conversation_id).toBeTruthy()
    expect(task!.context_key).toBe(task!.conversation_id)
  })

  it("email record exists in DB with correct agent_id and is_whitelisted=1", async () => {
    const from = `${seed.userId}@test.local`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = `E2E email-record ${randomUUID().slice(0, 8)}`

    await postEmail(from, to, subject, "Record check")

    await new Promise((r) => setTimeout(r, 2000))
    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM emails WHERE agent_id = '${seed.agentId}' AND subject = '${subject}'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].is_whitelisted).toBe(1)
    expect(rows[0].from_email).toBe(from)
  })

  it("non-whitelisted email does NOT create a task", async () => {
    const from = "unknown-sender@external.com"
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = `E2E no-task ${randomUUID().slice(0, 8)}`

    await postEmail(from, to, subject, "Should not trigger task")

    await new Promise((r) => setTimeout(r, 3000))
    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM agent_task_queue WHERE agent_id = '${seed.agentId}' AND prompt LIKE '%${subject}%'`,
    )
    expect(rows).toHaveLength(0)
  })
})
