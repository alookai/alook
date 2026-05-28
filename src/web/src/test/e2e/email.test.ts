import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun, sqlQuery, postEmail, postEmailRaw } from "@alook/test-utils"

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

// ─── Folder filtering ───

describe("email folder filtering", () => {
  it("GET /api/email?folder=untrust returns only non-whitelisted inbound emails", async () => {
    const agentEmail = `${seed.agentEmailHandle}@alook.ai`
    const now = new Date().toISOString()
    const rejId = `erej_${randomUUID().slice(0, 8)}`
    sqlRun(`INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, subject, r2_key, is_whitelisted, forwarded, message_id, in_reply_to, "references", created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, rejId, seed.agentId, seed.workspaceId, 'stranger@external.com', agentEmail, 'Untrust folder test', 'emails/fake-rej/raw', 0, 0, '', '', '', now)

    const res = await tokenRequest(
      `/api/email?workspace_id=${seed.workspaceId}&agentId=${seed.agentId}&folder=untrust`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)

    const emails = await res.json() as { is_whitelisted: boolean }[]
    expect(emails.length).toBeGreaterThan(0)
    for (const email of emails) {
      expect(email.is_whitelisted).toBe(false)
    }
  })

  it("GET /api/email?folder=untrust excludes sent emails", async () => {
    await tokenRequest(
      `/api/email/send?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: seed.agentId,
          to: "outbound@example.com",
          subject: "E2E sent email",
          htmlBody: "<p>Outbound</p>",
        }),
      },
    )

    const res = await tokenRequest(
      `/api/email?workspace_id=${seed.workspaceId}&agentId=${seed.agentId}&folder=untrust`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)

    const emails = await res.json() as { from_email: string; to_email: string }[]
    const agentEmail = `${seed.agentEmailHandle}@alook.ai`
    for (const email of emails) {
      expect(email.from_email).not.toBe(agentEmail)
    }
  })

  it("GET /api/email?folder=inbox returns only whitelisted inbound emails", async () => {
    const res = await tokenRequest(
      `/api/email?workspace_id=${seed.workspaceId}&agentId=${seed.agentId}&folder=inbox`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)

    const emails = await res.json() as { direction: string; is_whitelisted: boolean }[]
    for (const email of emails) {
      expect(email.direction).toBe("inbound")
      expect(email.is_whitelisted).toBe(true)
    }
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
    sqlRun(`INSERT INTO agent (id, workspace_id, name, runtime_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, tmpAgentId, seed.workspaceId, 'No Handle Agent', seed.runtimeId, seed.userId, now, now)

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
      sqlRun(`DELETE FROM agent WHERE id = ?`, tmpAgentId)
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

  it("POST /api/email/send with threading → stores message_id, in_reply_to, references", async () => {
    const inReplyTo = `<parent-${randomUUID()}@e2e.test>`
    const references = `<root-${randomUUID()}@e2e.test> ${inReplyTo}`

    const res = await tokenRequest(
      `/api/email/send?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: seed.agentId,
          to: "recipient@example.com",
          subject: "E2E reply test",
          htmlBody: "<p>Reply body</p>",
          inReplyTo,
          references,
        }),
      },
    )
    expect(res.status).toBe(200)

    const data = await res.json() as Record<string, unknown>
    expect(data.message_id).toBeTruthy()
    expect(typeof data.message_id).toBe("string")
    expect((data.message_id as string).length).toBeGreaterThan(0)
    expect(data.in_reply_to).toBe(inReplyTo)
    expect(data.references).toBe(references)
  })
})

// ─── Thread endpoint ───

describe("email thread", () => {
  it("GET /api/email/[id]/thread returns parent chain", async () => {
    const agentEmail = `${seed.agentEmailHandle}@alook.ai`
    const now = new Date().toISOString()
    const parentMsgId = `<thread-parent-${randomUUID()}@e2e.test>`
    const childMsgId = `<thread-child-${randomUUID()}@e2e.test>`

    // Insert parent email directly
    const parentId = `ep_${randomUUID().slice(0, 12)}`
    sqlRun(`INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, subject, r2_key, is_whitelisted, forwarded, message_id, in_reply_to, "references", created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, parentId, seed.agentId, seed.workspaceId, 'sender@test.com', agentEmail, 'Thread parent', 'emails/fake/raw', 1, 0, parentMsgId, '', '', now)

    // Insert child email that replies to parent
    const childId = `ec_${randomUUID().slice(0, 12)}`
    sqlRun(`INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, subject, r2_key, is_whitelisted, forwarded, message_id, in_reply_to, "references", direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, childId, seed.agentId, seed.workspaceId, agentEmail, 'sender@test.com', 'Re: Thread parent', 'emails/fake2/raw', 0, 0, childMsgId, parentMsgId, parentMsgId, 'outbound', now)

    const res = await tokenRequest(
      `/api/email/${childId}/thread?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)

    const thread = await res.json() as { id: string; message_id: string }[]
    expect(thread.length).toBe(1)
    expect(thread[0].id).toBe(parentId)
    expect(thread[0].message_id).toBe(parentMsgId)
  })

  it("GET /api/email/[id]/thread walks chain and returns empty for root", async () => {
    const agentEmail = `${seed.agentEmailHandle}@alook.ai`
    const now = new Date().toISOString()

    // Build a chain of 5 emails via individual INSERTs to verify the chain walk works
    // (MAX_DEPTH=50 is tested structurally — here we just verify the chain doesn't infinitely loop)
    const ids: string[] = []
    const mids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(`echain_${randomUUID().slice(0, 8)}`)
      mids.push(`<chain-${i}-${randomUUID().slice(0, 8)}@e2e.test>`)
    }

    for (let i = 0; i < 5; i++) {
      const irt = i > 0 ? mids[i - 1] : ""
      sqlRun(`INSERT INTO emails (id, agent_id, workspace_id, from_email, to_email, subject, r2_key, is_whitelisted, forwarded, message_id, in_reply_to, "references", created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ids[i], seed.agentId, seed.workspaceId, 'sender@test.com', agentEmail, `Chain ${i}`, 'emails/fake-chain/raw', 1, 0, mids[i], irt, '', now)
    }

    const res = await tokenRequest(
      `/api/email/${ids[4]}/thread?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)

    const thread = await res.json() as { id: string }[]
    expect(thread.length).toBe(4)
    expect(thread[0].id).toBe(ids[0])

    // Root email (ids[0]) has no in_reply_to — thread should be empty
    const rootRes = await tokenRequest(
      `/api/email/${ids[0]}/thread?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(rootRes.status).toBe(200)
    const rootThread = await rootRes.json() as unknown[]
    expect(rootThread).toHaveLength(0)
  })
})
