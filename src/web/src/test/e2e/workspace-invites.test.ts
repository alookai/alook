import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, signUp, signIn, sessionRequest, tokenRequest, sqlRun, sqlQuery } from "@alook/test-utils"

let seed: TestSeed

const inviteeEmail = `e2e_invitee_${randomUUID().slice(0, 8)}@test.local`
const inviteePassword = "TestPassword123!"
let inviteeCookie: string

beforeAll(async () => {
  seed = seedTestData()
  await signUp(inviteeEmail, inviteePassword, "Invitee User")
  inviteeCookie = await signIn(inviteeEmail, inviteePassword)
}, 60_000)

afterAll(() => {
  cleanupTestData(seed)
  try {
    sqlRun(`DELETE FROM member WHERE user_id IN (SELECT id FROM "user" WHERE email = ?)`, inviteeEmail)
    sqlRun(`DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, inviteeEmail)
    sqlRun(`DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, inviteeEmail)
    sqlRun(`DELETE FROM "user" WHERE email = ?`, inviteeEmail)
  } catch { /* ignore */ }
}, 60_000)

describe("workspace invite flow", () => {
  let inviteToken: string
  let inviteId: string

  it("POST /api/workspaces/:id/invites creates an invite (owner)", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/invites`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.token).toBeTruthy()
    expect(data.id).toBeTruthy()
    inviteToken = data.token as string
    inviteId = data.id as string
  })

  it("GET /api/workspaces/:id/invites lists active invites", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/invites`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.some(i => i.id === inviteId)).toBe(true)
  })

  it("GET /api/invite/:token returns invite details", async () => {
    const res = await sessionRequest(`/api/invite/${inviteToken}`, inviteeCookie)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.workspace_id).toBe(seed.workspaceId)
    expect(data.workspace_name).toBeTruthy()
  })

  it("POST /api/invite/:token accepts invite and creates membership", async () => {
    const res = await sessionRequest(`/api/invite/${inviteToken}`, inviteeCookie, {
      method: "POST",
    })
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.workspace_id).toBe(seed.workspaceId)
  })

  it("POST /api/invite/:token again returns 410 (already used)", async () => {
    const res = await sessionRequest(`/api/invite/${inviteToken}`, inviteeCookie, {
      method: "POST",
    })
    expect(res.status).toBe(410)
  })

  it("GET /api/workspaces/:id/members includes the new member", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/members`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.length).toBeGreaterThanOrEqual(2)
    expect(data.some(m => m.email === inviteeEmail)).toBe(true)
  })

  it("DELETE /api/workspaces/:id/invites/:inviteId on used invite", async () => {
    const createRes = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/invites`,
      seed.machineToken,
      { method: "POST" },
    )
    const { id: newInviteId } = await createRes.json() as Record<string, unknown>

    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/invites/${newInviteId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)
  })

  it("DELETE /api/workspaces/:id/invites/nonexistent returns 404", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/invites/nonexistent`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(404)
  })

  it("invited member creating studio does NOT overwrite workspace slug", async () => {
    const originalSlug = sqlQuery<{ slug: string }>(
      `SELECT slug FROM workspace WHERE id = ?`,
      seed.workspaceId,
    )[0].slug

    // Create a runtime owned by the invitee so they can pass the member-isolation check
    const inviteeUserId = sqlQuery<{ id: string }>(`SELECT id FROM "user" WHERE email = ?`, inviteeEmail)[0].id
    const now = new Date().toISOString()
    const inviteeDaemonId = `daemon_invitee_${Date.now()}`
    const inviteeRtId = `rt_invitee_${Date.now()}`
    sqlRun(`INSERT INTO machine (daemon_id, workspace_id, device_info, last_seen_at, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, inviteeDaemonId, seed.workspaceId, "test", now, now, now, inviteeUserId)
    sqlRun(`INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, inviteeRtId, seed.workspaceId, inviteeDaemonId, "local", "claude", "online", "test", now, now)

    const res = await sessionRequest(`/api/studios`, inviteeCookie, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-ID": seed.workspaceId,
      },
      body: JSON.stringify({
        name: "Hijacked Studio Name",
        members: [{ name: "Rogue", role: "leader", runtime_id: inviteeRtId }],
      }),
    })
    expect(res.status).toBe(201)

    const currentSlug = sqlQuery<{ slug: string }>(
      `SELECT slug FROM workspace WHERE id = ?`,
      seed.workspaceId,
    )[0].slug
    expect(currentSlug).toBe(originalSlug)
  })
})
