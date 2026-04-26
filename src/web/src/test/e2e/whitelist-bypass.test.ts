import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { sql, sqlQuery } from "../helpers/db"
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
  const EMAIL_WORKER_URL = process.env.EMAIL_WORKER_URL ?? "http://localhost:8787"

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
    // Create a second agent in the same workspace with its own email handle
    const siblingAgentId = `ag_${nanoid()}`
    const siblingHandle = `e2e-sib-${nanoid()}`
    const now = new Date().toISOString()
    sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES ('${siblingAgentId}', '${seed.workspaceId}', 'Sibling Agent', '${seed.runtimeId}', '${siblingHandle}', '${seed.userId}', '${now}', '${now}')`)

    try {
      // Sibling agent emails the seed agent — sibling is NOT in seed agent's whitelist
      const from = `${siblingHandle}@alook.ai`
      const to = `${seed.agentEmailHandle}@alook.ai`
      const subject = "E2E bypass test"

      const res = await fetch(
        `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawEmail(from, to, subject, "Hello from sibling"),
        },
      )
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
    const subject = "E2E self-email test"

    const res = await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Hello self"),
      },
    )
    expect(res.status).toBe(200)

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(1)
  })

  it("different-workspace agent email is NOT treated as whitelisted", async () => {
    // seedOther is in a different workspace — its agent email should not bypass
    const from = `${seedOther.agentEmailHandle}@alook.ai`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E cross-workspace test"

    const res = await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Cross workspace"),
      },
    )
    // May be 200 (stored but rejected) or rejected
    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(0)
  })

  it("@alook.ai email with nonexistent handle is NOT whitelisted", async () => {
    const from = `nonexistent-handle-${nanoid()}@alook.ai`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E nonexistent handle test"

    await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Ghost agent"),
      },
    )

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(0)
  })

  it("regular whitelist entries still work (existing behavior)", async () => {
    // seed.userId@test.local is in the whitelist — should still be whitelisted
    const from = `${seed.userId}@test.local`
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E regular whitelist test"

    const res = await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Regular whitelisted"),
      },
    )
    expect(res.status).toBe(200)

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(1)
  })

  it("non-whitelisted non-agent email is rejected (existing behavior)", async () => {
    const from = "random-stranger@gmail.com"
    const to = `${seed.agentEmailHandle}@alook.ai`
    const subject = "E2E stranger test"

    await fetch(
      `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawEmail(from, to, subject, "Stranger"),
      },
    )

    const row = await waitForEmail(seed.agentId, from)
    expect(row).not.toBeNull()
    expect(row!.is_whitelisted).toBe(0)
  })

  it("sender that is both whitelisted AND same-workspace agent is whitelisted", async () => {
    // Create a sibling agent and also add it to the whitelist
    const siblingAgentId = `ag_${nanoid()}`
    const siblingHandle = `e2e-both-${nanoid()}`
    const now = new Date().toISOString()
    const wlId = `wl_${nanoid()}`
    sql(`INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES ('${siblingAgentId}', '${seed.workspaceId}', 'Both Agent', '${seed.runtimeId}', '${siblingHandle}', '${seed.userId}', '${now}', '${now}')`)
    sql(`INSERT INTO agent_whitelist (id, agent_id, workspace_id, email, created_at) VALUES ('${wlId}', '${seed.agentId}', '${seed.workspaceId}', '${siblingHandle}@alook.ai', '${now}')`)

    try {
      const from = `${siblingHandle}@alook.ai`
      const to = `${seed.agentEmailHandle}@alook.ai`
      const subject = "E2E both paths test"

      const res = await fetch(
        `${EMAIL_WORKER_URL}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawEmail(from, to, subject, "Both paths"),
        },
      )
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
