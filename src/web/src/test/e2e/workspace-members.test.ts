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

describe("workspace member management", () => {
  it("GET /api/workspaces/:id/members returns members with user info", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/members`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.length).toBeGreaterThanOrEqual(2)

    const owner = data.find(m => m.user_id === seed.userId)
    expect(owner).toBeTruthy()
    expect(owner!.role).toBe("owner")

    const mem = data.find(m => m.user_id === secondary.userId)
    expect(mem).toBeTruthy()
    expect(mem!.role).toBe("member")
  })

  it("DELETE /api/workspaces/:id/members/:memberId removes a member", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/members/${secondary.memberId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)

    // Verify member is gone
    const listRes = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/members`,
      seed.machineToken,
    )
    const data = await listRes.json() as Array<Record<string, unknown>>
    expect(data.some(m => m.user_id === secondary.userId)).toBe(false)
  })

  it("DELETE /api/workspaces/:id/members/nonexistent returns 404", async () => {
    const res = await tokenRequest(
      `/api/workspaces/${seed.workspaceId}/members/nonexistent`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(404)
  })
})
