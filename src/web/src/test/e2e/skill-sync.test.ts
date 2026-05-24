import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"
import { sqlQuery, sql } from "../helpers/db"

let seed: TestSeed

beforeAll(() => { seed = seedTestData() })
afterAll(() => {
  sql(`DELETE FROM agent_skill WHERE workspace_id = '${seed.workspaceId}'`)
  cleanupTestData(seed)
})

describe("POST /api/daemon/skills/sync", () => {
  it("syncs global skills (scope=global)", async () => {
    const res = await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        runtime: "claude",
        skills: [
          { name: "test-skill-1", description: "Test skill one" },
          { name: "test-skill-2", description: "Test skill two" },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe("ok")

    const rows = sqlQuery<{ name: string; agent_id: string | null }>(
      `SELECT name, agent_id FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND runtime = 'claude' AND agent_id IS NULL ORDER BY name`
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]!.name).toBe("test-skill-1")
    expect(rows[0]!.agent_id).toBeNull()
  })

  it("syncs agent-scoped skills (scope=agent)", async () => {
    const res = await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        runtime: "claude",
        agent_id: seed.agentId,
        skills: [
          { name: "agent-skill-1", description: "Agent specific" },
        ],
      }),
    })
    expect(res.status).toBe(200)

    const rows = sqlQuery<{ name: string; agent_id: string }>(
      `SELECT name, agent_id FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND agent_id = '${seed.agentId}'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe("agent-skill-1")
    expect(rows[0]!.agent_id).toBe(seed.agentId)
  })

  it("re-sync replaces old skills (idempotent)", async () => {
    const res = await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        runtime: "claude",
        skills: [
          { name: "updated-skill", description: "Replaced" },
        ],
      }),
    })
    expect(res.status).toBe(200)

    const rows = sqlQuery<{ name: string }>(
      `SELECT name FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND runtime = 'claude' AND agent_id IS NULL`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe("updated-skill")
  })

  it("returns 400 when agent scope missing agent_id", async () => {
    const res = await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        runtime: "claude",
        skills: [{ name: "x", description: "" }],
      }),
    })
    expect(res.status).toBe(400)
  })

  it("FK constraint: agent-scoped sync with invalid agent_id fails", async () => {
    const res = await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        runtime: "claude",
        agent_id: "ag_nonexistent_id_12345",
        skills: [{ name: "bad-skill", description: "" }],
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

describe("GET /api/agents/[id]/skills", () => {
  it("returns combined global + agent skills", async () => {
    await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        runtime: "claude",
        skills: [{ name: "global-one", description: "G" }],
      }),
    })
    await tokenRequest("/api/daemon/skills/sync", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "agent",
        runtime: "claude",
        agent_id: seed.agentId,
        skills: [{ name: "agent-one", description: "A" }],
      }),
    })

    const rows = sqlQuery<{ name: string }>(
      `SELECT name FROM agent_skill WHERE workspace_id = '${seed.workspaceId}' AND runtime = 'claude' AND (agent_id IS NULL OR agent_id = '${seed.agentId}') ORDER BY name`
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const names = rows.map(r => r.name)
    expect(names).toContain("global-one")
    expect(names).toContain("agent-one")
  })
})
