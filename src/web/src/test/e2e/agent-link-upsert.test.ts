import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun } from "@alook/test-utils"
import { nanoid } from "nanoid"

let seed: TestSeed
let targetAgentId: string

beforeAll(() => {
  seed = seedTestData()
  // Second agent in the same workspace, owned by the same user, to link against.
  targetAgentId = `ag_${nanoid()}`
  const now = new Date().toISOString()
  sqlRun(
    `INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    targetAgentId, seed.workspaceId, "Target Agent", seed.runtimeId, `target-${nanoid(6).toLowerCase()}`, seed.userId, now, now,
  )
})

afterAll(() => {
  sqlRun(
    `DELETE FROM agent_link WHERE (source_agent_id = ? AND target_agent_id = ?) OR (source_agent_id = ? AND target_agent_id = ?)`,
    seed.agentId, targetAgentId, targetAgentId, seed.agentId,
  )
  sqlRun(`DELETE FROM agent WHERE id = ?`, targetAgentId)
  cleanupTestData(seed)
})

function upsert(body: unknown) {
  return tokenRequest(
    `/api/agent-links?workspace_id=${seed.workspaceId}&agentId=${seed.agentId}`,
    seed.machineToken,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )
}

describe("PUT /api/agent-links (upsert)", () => {
  it("creates the link on first call (201, created:true)", async () => {
    const res = await upsert({ target_agent_id: targetAgentId, instruction: "first instruction" })
    expect(res.status).toBe(201)
    const data = await res.json() as { created: boolean; instruction: string; source_agent_id: string; target_agent_id: string }
    expect(data.created).toBe(true)
    expect(data.instruction).toBe("first instruction")
    const ids = [data.source_agent_id, data.target_agent_id]
    expect(ids).toContain(seed.agentId)
    expect(ids).toContain(targetAgentId)
  })

  it("replaces the instruction on second call (200, created:false) — single row", async () => {
    const res = await upsert({ target_agent_id: targetAgentId, instruction: "second instruction" })
    expect(res.status).toBe(200)
    const data = await res.json() as { created: boolean; instruction: string }
    expect(data.created).toBe(false)
    expect(data.instruction).toBe("second instruction")

    // Exactly one row for this pair (canonicalization held); instruction replaced.
    const list = await tokenRequest(
      `/api/agent-links?workspace_id=${seed.workspaceId}&limit=500`,
      seed.machineToken,
      { method: "GET" },
    )
    const links = await list.json() as Array<{ source_agent_id: string; target_agent_id: string; instruction: string }>
    const forPair = links.filter((l) =>
      (l.source_agent_id === seed.agentId && l.target_agent_id === targetAgentId) ||
      (l.source_agent_id === targetAgentId && l.target_agent_id === seed.agentId),
    )
    expect(forPair).toHaveLength(1)
    expect(forPair[0].instruction).toBe("second instruction")
  })

  it("returns 400 on self-link", async () => {
    const res = await upsert({ target_agent_id: seed.agentId, instruction: "x" })
    expect(res.status).toBe(400)
  })

  it("returns 404 for a target not in the workspace", async () => {
    const res = await upsert({ target_agent_id: "ag_nonexistent_xyz", instruction: "x" })
    expect(res.status).toBe(404)
  })

  it("returns 400 without agentId query param", async () => {
    const res = await tokenRequest(
      `/api/agent-links?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_agent_id: targetAgentId, instruction: "x" }),
      },
    )
    expect(res.status).toBe(400)
  })
})
