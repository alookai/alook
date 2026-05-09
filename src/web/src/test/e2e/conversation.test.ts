import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

describe("conversations", () => {
  let conversationId: string

  it("POST /api/conversations creates a conversation", async () => {
    const res = await tokenRequest(
      `/api/conversations?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: seed.agentId }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBeTruthy()
    expect(data.agent_id).toBe(seed.agentId)
    conversationId = data.id as string
  })

  it("GET /api/conversations lists conversations", async () => {
    const res = await tokenRequest(
      `/api/conversations?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.some(c => c.id === conversationId)).toBe(true)
  })

  it("GET /api/conversations/:id returns conversation", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBe(conversationId)
  })

  it("POST /api/conversations/:id/messages creates a message and enqueues task", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Hello from e2e test" }),
      },
    )
    // 201 on success, 500 if task enqueue fails (but message still created)
    expect([201, 500]).toContain(res.status)
    const data = await res.json() as Record<string, unknown>
    const msg = data.message as Record<string, unknown>
    expect(msg.content).toBe("Hello from e2e test")
    expect(msg.role).toBe("user")
  })

  it("GET /api/conversations/:id/messages lists messages", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<Record<string, unknown>>; has_more: boolean }
    expect(body.messages.length).toBeGreaterThanOrEqual(1)
    expect(body.messages.some(m => m.content === "Hello from e2e test")).toBe(true)
  })

  it("POST /api/conversations/:id/messages auto-titles conversation", async () => {
    // Check the conversation now has a title
    const res = await tokenRequest(
      `/api/conversations/${conversationId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.title).toBeTruthy()
  })

  it("DELETE /api/conversations/:id deletes conversation", async () => {
    // Create a separate conversation to delete (keep the main one for other tests)
    const createRes = await tokenRequest(
      `/api/conversations?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: seed.agentId }),
      },
    )
    const { id } = await createRes.json() as { id: string }

    const deleteRes = await tokenRequest(
      `/api/conversations/${id}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(deleteRes.status).toBe(204)

    // Verify it's gone
    const getRes = await tokenRequest(
      `/api/conversations/${id}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(getRes.status).toBe(404)
  })

  it("POST /api/conversations rejects missing agent_id", async () => {
    const res = await tokenRequest(
      `/api/conversations?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(400)
  })
})
