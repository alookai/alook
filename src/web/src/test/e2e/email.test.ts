import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, sqlQuery, postEmail, postEmailRaw } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

/** Poll D1 until at least one email row matches, or timeout */
async function waitForEmail(
  agentId: string,
  fromEmail: string,
  maxMs = 5000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM emails WHERE agent_id = ? AND from_email = ? ORDER BY created_at DESC LIMIT 1`, agentId, fromEmail
    )
    if (rows.length > 0) return rows[0]
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

// ─── Receive path ───

describe("email receive (inbound)", () => {
  it("whitelisted sender → DB record with is_whitelisted = 1", async () => {
    const from = `${seed.userId}@test.local` // whitelisted in seed
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E whitelisted test"

    const res = await postEmail(from, to, subject, "Hello from e2e")
    expect(res.status).toBe(200)

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.subject).toBe(subject)
    expect(row!.is_whitelisted).toBe(1)
  })

  it("non-whitelisted sender → DB record with is_whitelisted = 0", async () => {
    const from = "stranger@external.com"
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E non-whitelisted test"

    await postEmail(from, to, subject, "Stranger email")

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.subject).toBe(subject)
    expect(row!.is_whitelisted).toBe(0)
  })

  it("unknown handle → no email record created", async () => {
    const from = "anyone@example.com"
    const to = "nonexistent-handle-xyz@alook.ai"
    const subject = "E2E unknown handle"

    await postEmail(from, to, subject, "Should be rejected")

    // Small wait to ensure nothing is written
    await new Promise((r) => setTimeout(r, 1000))

    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM emails WHERE from_email = ? AND subject = ?`, from, subject
    )
    expect(rows).toHaveLength(0)
  })
})

// ─── Threading on ingest ───

describe("email threading (inbound)", () => {
  it("stores Message-ID, In-Reply-To, References from incoming email", async () => {
    const from = `${seed.userId}@test.local`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E threading test"
    const msgId = `<threading-${randomUUID()}@e2e.test>`
    const inReplyTo = `<parent-${randomUUID()}@e2e.test>`
    const references = `<root-${randomUUID()}@e2e.test> ${inReplyTo}`

    const raw = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: ${msgId}`,
      `In-Reply-To: ${inReplyTo}`,
      `References: ${references}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      "",
      "Thread test body",
    ].join("\r\n")

    await postEmailRaw(from, to, raw)

    const row = await waitForEmail(seed.agentId, from, 5000)
    expect(row).not.toBeNull()
    expect(row!.message_id).toBe(msgId)
    expect(row!.in_reply_to).toBe(inReplyTo)
    expect(row!.references).toBe(references)
  })

  it("stores empty strings when threading headers are absent", async () => {
    // Verify via the first whitelisted email (already created above) which has no In-Reply-To/References
    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM emails WHERE agent_id = ? AND is_whitelisted = ? AND in_reply_to = ? LIMIT 1`, seed.agentId, 1, ''
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].in_reply_to).toBe("")
    expect(rows[0].references).toBe("")
  })
})
