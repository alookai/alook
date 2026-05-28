import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun } from "@alook/test-utils"

let seed: TestSeed
let recruitedAgentId: string

beforeAll(() => {
  seed = seedTestData()
})

afterAll(() => {
  if (recruitedAgentId) {
    sqlRun(`DELETE FROM agent_task_queue WHERE agent_id = ?`, recruitedAgentId)
    sqlRun(`DELETE FROM message WHERE conversation_id IN (SELECT id FROM conversation WHERE agent_id = ?)`, recruitedAgentId)
    sqlRun(`DELETE FROM conversation WHERE agent_id = ?`, recruitedAgentId)
    sqlRun(`DELETE FROM agent_whitelist WHERE agent_id = ?`, recruitedAgentId)
    sqlRun(`DELETE FROM agent_link WHERE (source_agent_id = ? AND target_agent_id = ?) OR (source_agent_id = ? AND target_agent_id = ?)`, seed.agentId, recruitedAgentId, recruitedAgentId, seed.agentId)
    sqlRun(`DELETE FROM agent WHERE id = ?`, recruitedAgentId)
  }
  cleanupTestData(seed)
})

describe("POST /api/agents/recruit", () => {
  it("recruits a new agent and returns agent + link", async () => {
    const res = await tokenRequest(
      `/api/agents/recruit?workspace_id=${seed.workspaceId}&agentId=${seed.agentId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "RecruitedBot",
          description: "A test recruited agent",
          instructions: "You are a helper bot",
          relationship: "Helps with testing",
        }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as { agent: Record<string, unknown>; link: Record<string, unknown> }
    expect(data.agent).toBeTruthy()
    expect(data.agent.name).toBe("RecruitedBot")
    expect(data.agent.email).toBeTruthy()
    expect(data.link).toBeTruthy()
    expect(data.link.source_agent_id).toBeTruthy()
    expect(data.link.target_agent_id).toBeTruthy()
    const linkAgentIds = [data.link.source_agent_id, data.link.target_agent_id]
    expect(linkAgentIds).toContain(data.agent.id)
    expect(linkAgentIds).toContain(seed.agentId)
    recruitedAgentId = data.agent.id as string
  })

  it("returns 400 without agentId query param", async () => {
    const res = await tokenRequest(
      `/api/agents/recruit?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ShouldFail",
          instructions: "test",
          relationship: "test",
        }),
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 for non-existent calling agent", async () => {
    const res = await tokenRequest(
      `/api/agents/recruit?workspace_id=${seed.workspaceId}&agentId=ag_nonexistent_xyz`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ShouldFail",
          instructions: "test",
          relationship: "test",
        }),
      },
    )
    expect(res.status).toBe(404)
  })

  it("rejects unauthenticated request", async () => {
    const res = await fetch(
      `${process.env.APP_URL || "http://localhost:3000"}/api/agents/recruit?workspace_id=${seed.workspaceId}&agentId=${seed.agentId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "NoAuth", instructions: "x", relationship: "x" }),
      },
    )
    expect(res.status).toBe(401)
  })
})
