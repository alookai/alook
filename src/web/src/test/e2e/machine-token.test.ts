import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, sessionRequest, tokenRequest, sqlRun, sqlQuery, fetchWithRetry } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

describe("machine tokens", () => {
  it("GET /api/machine-tokens lists tokens (requires workspace header)", async () => {
    const res = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(data)).toBe(true)
    expect(data.some(t => t.id === seed.machineTokenId)).toBe(true)
  })

  it("POST /api/machine-tokens creates a new token", async () => {
    const res = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "e2e-created" }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.token).toBeTruthy()
    expect((data.token as string).startsWith("al_")).toBe(true)
    expect(data.name).toBe("e2e-created")

    // Verify the new token works for auth
    const meRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      data.token as string,
    )
    expect(meRes.status).toBe(200)

    // Cleanup: delete the created token
    const deleteRes = await tokenRequest(
      `/api/machine-tokens/${data.id}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(deleteRes.status).toBe(204)
  })

  it("DELETE /api/machine-tokens/:id removes token", async () => {
    // Create a token to delete
    const createRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "to-delete" }),
      },
    )
    const { id, token: newRawToken } = await createRes.json() as { id: string; token: string }

    const deleteRes = await tokenRequest(
      `/api/machine-tokens/${id}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(deleteRes.status).toBe(204)

    // Verify deleted token no longer works
    const verifyRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      newRawToken,
    )
    expect(verifyRes.status).toBe(401)
  })
})

describe("machine token activation (decoupled — no workspace creation)", () => {
  it("activation sets token to active status and creates machine/runtime rows", async () => {
    const tokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
    const rawToken = `al_${randomUUID().replace(/-/g, "")}`
    const now = new Date().toISOString()
    sqlRun(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, tokenId, seed.userId, seed.workspaceId, rawToken, 'activate-test', 'pending', now)

    const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
    const res = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: rawToken,
        hostname: "e2e-activate-machine",
        runtimes: [{ type: "claude", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { daemon_id: string; workspace_id: string; runtimes: Array<{ id: string }> }

    expect(data.daemon_id).toBe("e2e-activate-machine")
    expect(data.workspace_id).toBe(seed.workspaceId)
    expect(data.runtimes.length).toBeGreaterThan(0)

    // Verify DB state
    const rows = sqlQuery<{ status: string; hostname: string }>(
      `SELECT status, hostname FROM machine_token WHERE id = ?`, tokenId,
    )
    expect(rows[0]!.status).toBe("active")
    expect(rows[0]!.hostname).toBe("e2e-activate-machine")
  })

  it("activation rejects already-used token with 409", async () => {
    const tokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
    const rawToken = `al_${randomUUID().replace(/-/g, "")}`
    const now = new Date().toISOString()
    sqlRun(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, tokenId, seed.userId, seed.workspaceId, rawToken, 'active-token', 'active', now)

    const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
    const res = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: rawToken,
        hostname: "e2e-rejected",
        runtimes: [{ type: "claude", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(409)
    const data = await res.json() as { error: string }
    expect(data.error).toBe("token already used")
  })
})
