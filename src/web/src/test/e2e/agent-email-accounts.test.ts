import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun } from "@alook/test-utils"

let seed: TestSeed
let accountId: string

beforeAll(() => {
  seed = seedTestData()
})

afterAll(() => {
  if (accountId) {
    sqlRun(`DELETE FROM agent_email_account WHERE id = ?`, accountId)
  }
  cleanupTestData(seed)
})

describe("GET /api/agents/[id]/email-accounts", () => {
  it("returns empty list when no accounts configured", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/email-accounts?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
  })

  it("returns 404 for non-existent agent", async () => {
    const res = await tokenRequest(
      `/api/agents/ag_nonexistent_xyz/email-accounts?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(404)
  })
})

describe("POST /api/agents/[id]/email-accounts", () => {
  it("creates an email account", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/email-accounts?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailAddress: "test@example.com",
          displayName: "Test Account",
          imapHost: "imap.example.com",
          imapPort: 993,
          imapUsername: "test@example.com",
          imapPassword: "password123",
          imapTls: true,
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          smtpUsername: "test@example.com",
          smtpPassword: "password123",
          smtpTls: 1,
          pollIntervalSeconds: 60,
        }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBeTruthy()
    expect(data.email_address).toBe("test@example.com")
    expect(data.display_name).toBe("Test Account")
    expect(data.imap_host).toBe("imap.example.com")
    expect(data.smtp_host).toBe("smtp.example.com")
    expect(data.status).toBeTruthy()
    accountId = data.id as string
  })

  it("lists the created account", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/email-accounts?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.length).toBeGreaterThanOrEqual(1)
    expect(data.some(a => a.id === accountId)).toBe(true)
  })

  it("returns 404 for non-existent agent on create", async () => {
    const res = await tokenRequest(
      `/api/agents/ag_nonexistent_xyz/email-accounts?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailAddress: "fail@example.com",
          displayName: "Fail",
          imapHost: "imap.example.com",
          imapPort: 993,
          imapUsername: "fail@example.com",
          imapPassword: "pass",
          imapTls: true,
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          smtpUsername: "fail@example.com",
          smtpPassword: "pass",
          smtpTls: 1,
          pollIntervalSeconds: 60,
        }),
      },
    )
    expect(res.status).toBe(404)
  })

  it("rejects unauthenticated request", async () => {
    const res = await fetch(
      `${process.env.APP_URL || "http://localhost:3000"}/api/agents/${seed.agentId}/email-accounts?workspace_id=${seed.workspaceId}`,
    )
    expect(res.status).toBe(401)
  })
})
