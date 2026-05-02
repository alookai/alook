import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
}, 60_000)

afterAll(() => {
  cleanupTestData(seed)
}, 60_000)

describe("agent pin", () => {
  it("GET /api/agents/pins returns empty list initially", async () => {
    const res = await tokenRequest(
      `/api/agents/pins?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { pins: Array<Record<string, unknown>>; sidebar_order: Array<Record<string, unknown>> }
    expect(data.pins).toEqual([])
  })

  it("POST /api/agents/:id/pin pins an agent", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/pin?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.pinned).toBe(true)
  })

  it("POST /api/agents/:id/pin again returns 200 (already pinned)", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/pin?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.pinned).toBe(true)
  })

  it("GET /api/agents/pins returns the pinned agent", async () => {
    const res = await tokenRequest(
      `/api/agents/pins?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { pins: Array<Record<string, unknown>>; sidebar_order: Array<Record<string, unknown>> }
    expect(data.pins).toHaveLength(1)
    expect(data.pins[0].agent_id).toBe(seed.agentId)
  })

  it("DELETE /api/agents/:id/pin unpins the agent", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/pin?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)
  })

  it("GET /api/agents/pins returns empty after unpin", async () => {
    const res = await tokenRequest(
      `/api/agents/pins?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { pins: Array<Record<string, unknown>>; sidebar_order: Array<Record<string, unknown>> }
    expect(data.pins).toEqual([])
  })

  it("DELETE /api/agents/:id/pin is idempotent (unpin again)", async () => {
    const res = await tokenRequest(
      `/api/agents/${seed.agentId}/pin?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)
  })

  it("POST /api/agents/:id/pin returns 404 for nonexistent agent", async () => {
    const res = await tokenRequest(
      `/api/agents/nonexistent/pin?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(404)
  })
})
