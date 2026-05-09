import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest } from "../helpers/auth"
import { sqlBatch } from "../helpers/db"

const testEmail = `e2e_ws_${randomUUID().slice(0, 8)}@test.local`
const testPassword = "TestPassword123!"
let cookie: string

beforeAll(async () => {
  await signUp(testEmail, testPassword, "WS User")
  cookie = await signIn(testEmail, testPassword)
})

afterAll(() => {
  try {
    sqlBatch([
      `DELETE FROM workspace WHERE id IN (SELECT workspace_id FROM member WHERE user_id IN (SELECT id FROM "user" WHERE email = '${testEmail}'))`,
      `DELETE FROM member WHERE user_id IN (SELECT id FROM "user" WHERE email = '${testEmail}')`,
      `DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = '${testEmail}')`,
      `DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = '${testEmail}')`,
      `DELETE FROM "user" WHERE email = '${testEmail}'`,
    ])
  } catch { /* ignore */ }
})

describe("workspace", () => {
  const slug = `e2e-ws-${randomUUID().slice(0, 8)}`
  let workspaceId: string

  it("POST /api/workspaces creates a workspace", async () => {
    const res = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Workspace", slug }),
    })
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.name).toBe("E2E Workspace")
    expect(data.slug).toBe(slug)
    expect(data.id).toBeTruthy()
    workspaceId = data.id as string
  })

  it("POST /api/workspaces auto-suffixes duplicate slug", async () => {
    const res = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dup Workspace", slug }),
    })
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.name).toBe("Dup Workspace")
    // Slug should start with the original slug but have a suffix
    expect(data.slug).not.toBe(slug)
    expect((data.slug as string).startsWith(`${slug}-`)).toBe(true)
  })

  it("GET /api/workspaces lists user's workspaces", async () => {
    const res = await sessionRequest("/api/workspaces", cookie)
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.some(w => w.slug === slug)).toBe(true)
  })

  it("GET /api/workspaces/:id returns workspace", async () => {
    const res = await sessionRequest(`/api/workspaces/${workspaceId}`, cookie)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBe(workspaceId)
    expect(data.name).toBe("E2E Workspace")
  })

  it("POST /api/workspaces rejects missing name", async () => {
    const res = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "no-name" }),
    })
    expect(res.status).toBe(400)
  })
})
