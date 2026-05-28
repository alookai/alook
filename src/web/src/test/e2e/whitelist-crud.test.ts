import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "@alook/test-utils"
import { tokenRequest } from "@alook/test-utils"

let seed: TestSeed
let seedB: TestSeed

beforeAll(() => {
  seed = seedTestData()
  seedB = seedTestData()
}, 60_000)
afterAll(() => {
  cleanupTestData(seed)
  cleanupTestData(seedB)
}, 60_000)

describe("whitelist CRUD", () => {
  let addedEntryId: string

  it("GET /api/agents/:id/whitelist returns seeded entry", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(seed.whitelistId)
    expect(data[0].email).toBe(`${seed.userId}@test.local`)
  })

  it("POST /api/agents/:id/whitelist adds new email", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new-sender@example.com" }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.email).toBe("new-sender@example.com")
    expect(data.id).toBeTruthy()
    addedEntryId = data.id as string
  })

  it("GET /api/agents/:id/whitelist now returns both entries", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data).toHaveLength(2)
    expect(data.some((e) => e.id === seed.whitelistId)).toBe(true)
    expect(data.some((e) => e.id === addedEntryId)).toBe(true)
  })

  it("DELETE /api/agents/:id/whitelist/:whitelistId removes entry", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist/${addedEntryId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)
  })

  it("GET /api/agents/:id/whitelist returns only seeded entry after delete", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe(seed.whitelistId)
  })

  it("POST /api/agents/:id/whitelist returns 409 for duplicate", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${seed.userId}@test.local` }),
      },
    )
    expect(res.status).toBe(409)
  })

  it("POST /api/agents/:id/whitelist normalizes to lowercase", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "UPPERCASE@EXAMPLE.COM" }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.email).toBe("uppercase@example.com")
  })

  it("GET /api/agents/:id/whitelist returns 404 for nonexistent agent", async () => {
    const res = await tokenRequest(
      `/api/agents/nonexistent/whitelist?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(404)
  })
})

describe("whitelist workspace isolation", () => {
  it("DELETE with valid whitelistId but wrong workspace returns 404", async () => {
    const res = await tokenRequest(
      `/api/agents/${seedB.agentId}/whitelist/${seed.whitelistId}?workspace_id=${seedB.workspaceId}`,
      seedB.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(404)
  })
})
