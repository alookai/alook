import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"
import { sql, sqlQuery } from "../helpers/db"

let seed: TestSeed
let conversationId: string
let activeTaskId: string

beforeAll(async () => {
  seed = seedTestData()
  // Create a conversation
  const res = await tokenRequest(
    `/api/conversations?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: seed.agentId }),
    },
  )
  const data = await res.json() as { id: string }
  conversationId = data.id

  activeTaskId = `task_${Date.now()}`
  const now = new Date().toISOString()
  sql(
    `INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, status, type, created_at) VALUES ('${activeTaskId}', '${seed.agentId}', '${seed.runtimeId}', '${seed.workspaceId}', '${conversationId}', 'active task', 'running', 'user_dm_message', '${now}')`
  )
})
afterAll(() => cleanupTestData(seed))

describe("buffered messages CRUD", () => {
  let bufferedMsgId: string

  it("POST creates a buffered message", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Follow-up 1" }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as { message: Record<string, unknown> }
    expect(data.message.content).toBe("Follow-up 1")
    expect(data.message.status).toBe("buffered")
    bufferedMsgId = data.message.id as string
  })

  it("GET returns buffered messages in order", async () => {
    // Create a second one
    await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Follow-up 2" }),
      },
    )

    const res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.length).toBeGreaterThanOrEqual(2)
    expect(data[0].content).toBe("Follow-up 1")
    expect(data[1].content).toBe("Follow-up 2")
  })

  it("buffered messages are excluded from normal message listing", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    const buffered = data.filter((m) => m.status === "buffered")
    expect(buffered.length).toBe(0)
  })

  it("DELETE single removes a specific buffered message", async () => {
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages/${bufferedMsgId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)

    // Verify it's gone
    const listRes = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    const remaining = await listRes.json() as Array<Record<string, unknown>>
    expect(remaining.find((m) => m.id === bufferedMsgId)).toBeUndefined()
  })

  it("DELETE bulk removes all buffered messages", async () => {
    // Create a couple more
    await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Bulk delete test 1" }),
      },
    )
    await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Bulk delete test 2" }),
      },
    )

    const res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(204)

    const listRes = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    const remaining = await listRes.json() as Array<Record<string, unknown>>
    expect(remaining.length).toBe(0)
  })

  it("POST rejects with 429 when 20 buffered messages exist", async () => {
    // Create 20 messages
    for (let i = 0; i < 20; i++) {
      await tokenRequest(
        `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
        seed.machineToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `Cap test ${i}` }),
        },
      )
    }

    // 21st should fail
    const res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Over the limit" }),
      },
    )
    expect(res.status).toBe(429)

    // Cleanup
    await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
  })

  it("cannot delete a non-buffered message via buffered endpoint", async () => {
    // Create a normal message via SQL
    const msgId = `test_active_${Date.now()}`
    const now = new Date().toISOString()
    sql(
      `INSERT INTO message (id, conversation_id, role, content, status, created_at) VALUES ('${msgId}', '${conversationId}', 'user', 'normal msg', 'active', '${now}')`
    )

    const res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages/${msgId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(res.status).toBe(400)

    // Cleanup
    sql(`DELETE FROM message WHERE id = '${msgId}'`)
  })
})
