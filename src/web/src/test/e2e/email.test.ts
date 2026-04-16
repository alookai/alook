import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"
import { sql, sqlQuery } from "../helpers/db"

const EMAIL_WORKER_URL = process.env.EMAIL_WORKER_URL ?? "http://localhost:8787"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

/** Build a minimal RFC 5322 email with Message-ID (required by wrangler) */
function rawEmail(from: string, to: string, subject: string, body: string): string {
  const msgId = `<${randomUUID()}@e2e.test>`
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${msgId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    body,
  ].join("\r\n")
}

/** Poll D1 until at least one email row matches, or timeout */
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

// ─── Receive path ───

describe("email receive (inbound)", () => {
  it("whitelisted sender → DB record with is_whitelisted = 1", async () => {
    const from = `${seed.userId}@test.local` // whitelisted in seed
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E whitelisted test"

    const res = await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Hello from e2e"),
      },
    )
    // wrangler returns 200 for accepted emails
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

    await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Stranger email"),
      },
    )

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.subject).toBe(subject)
    expect(row!.is_whitelisted).toBe(0)
  })

  it("unknown handle → no email record created", async () => {
    const from = "anyone@example.com"
    const to = "nonexistent-handle-xyz@alook.ai"
    const subject = "E2E unknown handle"

    await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Should be rejected"),
      },
    )

    // Small wait to ensure nothing is written
    await new Promise((r) => setTimeout(r, 1000))

    const rows = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM emails WHERE from_email = '${from}' AND subject = '${subject}'`,
    )
    expect(rows).toHaveLength(0)
  })
})

// ─── Send path ───

describe("email send (outbound)", () => {
  it("POST /api/email/send → 200 with r2_key and DB record", async () => {
    const res = await tokenRequest(
      `/api/email/send?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: seed.agentId,
          to: "recipient@example.com",
          subject: "E2E send test",
          htmlBody: "<p>Hello from e2e</p>",
        }),
      },
    )
    expect(res.status).toBe(200)

    const data = await res.json() as Record<string, unknown>
    expect(data.r2_key).toBeTruthy()
    expect(data.from_email).toBe(`${seed.agentEmailHandle}@alook.ai`)
    expect(data.to_email).toBe("recipient@example.com")
    expect(data.subject).toBe("E2E send test")
  })

  it("POST /api/email/send with agent missing emailHandle → 400", async () => {
    // Create a temporary agent without emailHandle
    const tmpAgentId = `ag_tmp_${Date.now()}`
    const now = new Date().toISOString()
    sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, created_at, updated_at) VALUES ('${tmpAgentId}', '${seed.workspaceId}', 'No Handle Agent', '${seed.runtimeId}', '${now}', '${now}')`)

    try {
      const res = await tokenRequest(
        `/api/email/send?workspace_id=${seed.workspaceId}`,
        seed.machineToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: tmpAgentId,
            to: "someone@example.com",
            subject: "Should fail",
            htmlBody: "<p>No handle</p>",
          }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      sql(`DELETE FROM agent WHERE id = '${tmpAgentId}'`)
    }
  })

  it("POST /api/email/send missing required fields → 400", async () => {
    const res = await tokenRequest(
      `/api/email/send?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: seed.agentId }),
      },
    )
    expect(res.status).toBe(400)
  })
})
