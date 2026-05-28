import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "@alook/test-utils"
import { tokenRequest } from "@alook/test-utils"
import { sql } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

const wsHeader = (wsId: string) => ({ "X-Workspace-ID": wsId })

describe("agent CRUD", () => {
  let createdAgentId: string

  it("POST /api/agents creates an agent", async () => {
    const res = await tokenRequest("/api/agents", seed.machineToken, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...wsHeader(seed.workspaceId),
      },
      body: JSON.stringify({
        name: "E2E Agent",
        description: "Created by e2e test",
        instructions: "Be helpful",
        runtime_id: seed.runtimeId,
      }),
    })
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.name).toBe("E2E Agent")
    expect(data.description).toBe("Created by e2e test")
    expect(data.runtime_id).toBe(seed.runtimeId)
    createdAgentId = data.id as string
  })

  it("GET /api/agents lists agents in workspace", async () => {
    const res = await tokenRequest(
      `/api/agents?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(data)).toBe(true)
    // Should include both the seeded agent and the created agent
    expect(data.some(a => a.id === createdAgentId)).toBe(true)
    expect(data.some(a => a.id === seed.agentId)).toBe(true)
  })

  it("GET /api/agents/:id returns single agent", async () => {
    const res = await tokenRequest(
      `/api/agents/${createdAgentId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBe(createdAgentId)
    expect(data.name).toBe("E2E Agent")
  })

  it("PATCH /api/agents/:id updates agent", async () => {
    const res = await tokenRequest(
      `/api/agents/${createdAgentId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "E2E Agent Updated", description: "Updated" }),
      },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.name).toBe("E2E Agent Updated")
    expect(data.description).toBe("Updated")
  })

  it("PATCH /api/agents/:id persists runtime_config.model", async () => {
    const patchRes = await tokenRequest(
      `/api/agents/${createdAgentId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime_config: { model: "test-model" } }),
      },
    )
    expect(patchRes.status).toBe(200)

    const getRes = await tokenRequest(
      `/api/agents/${createdAgentId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(getRes.status).toBe(200)
    const data = await getRes.json() as Record<string, unknown>
    expect((data.runtime_config as Record<string, unknown>)?.model).toBe("test-model")
  })

  it("DELETE /api/agents/:id deletes agent", async () => {
    const res = await tokenRequest(
      `/api/agents/${createdAgentId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)

    // Verify it's gone
    const getRes = await tokenRequest(
      `/api/agents/${createdAgentId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(getRes.status).toBe(404)
  })

  it("GET /api/agents/:id returns 404 for nonexistent", async () => {
    const res = await tokenRequest(
      `/api/agents/nonexistent?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(404)
  })

  it("POST /api/agents rejects missing name", async () => {
    const res = await tokenRequest("/api/agents", seed.machineToken, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...wsHeader(seed.workspaceId),
      },
      body: JSON.stringify({ runtime_id: seed.runtimeId }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /api/agents rejects missing runtime_id", async () => {
    const res = await tokenRequest("/api/agents", seed.machineToken, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...wsHeader(seed.workspaceId),
      },
      body: JSON.stringify({ name: "No Runtime" }),
    })
    expect(res.status).toBe(400)
  })
})
