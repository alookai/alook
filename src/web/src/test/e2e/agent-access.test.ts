import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  seedTestData, cleanupTestData, type TestSeed,
  seedSecondaryUser, cleanupSecondaryUser, type SecondaryUser,
} from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"

let seed: TestSeed
let secondary: SecondaryUser

beforeAll(() => {
  seed = seedTestData()
  secondary = seedSecondaryUser(seed.workspaceId, "member")
}, 60_000)

afterAll(() => {
  cleanupSecondaryUser(secondary)
  cleanupTestData(seed)
}, 60_000)

describe("agent access control", () => {
  it("GET /api/agents/:id/access returns empty list initially", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data).toEqual([])
  })

  it("POST /api/agents/:id/access grants access to secondary user", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: secondary.userId }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.user_id).toBe(secondary.userId)
  })

  it("GET /api/agents/:id/access now includes the granted user", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data).toHaveLength(1)
    expect(data[0].user_id).toBe(secondary.userId)
  })

  it("POST /api/agents/:id/access also adds user email to whitelist", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    const secondaryEmail = `${secondary.userId}@test.local`
    expect(data.some(w => w.email === secondaryEmail)).toBe(true)
  })

  it("DELETE /api/agents/:id/access/:userId revokes access", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access/${secondary.userId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)
  })

  it("GET /api/agents/:id/access is empty after revoke", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data).toEqual([])
  })

  it("DELETE /api/agents/:id/access/:userId with remove_whitelist=true also removes whitelist", async () => {
    // Grant access again first
    await tokenRequest(
      `/api/agents/${seed.agentId}/access?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: secondary.userId }),
      },
    )

    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access/${secondary.userId}?workspace_id=${seed.workspaceId}&remove_whitelist=true`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)

    // Verify whitelist entry removed
    const wlRes = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    const wlData = await wlRes.json() as Array<Record<string, unknown>>
    const secondaryEmail = `${secondary.userId}@test.local`
    expect(wlData.some(w => w.email === secondaryEmail)).toBe(false)
  })

  it("DELETE /api/agents/:id/access/nonexistent returns 404", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/access/nonexistent?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(404)
  })
})
