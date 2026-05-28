import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun } from "@alook/test-utils"

let seed: TestSeed
let conversationId: string
let taskId: string

beforeAll(async () => {
  seed = seedTestData()

  const convRes = await tokenRequest(
    `/api/conversations?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: seed.agentId }),
    },
  )
  const convData = await convRes.json() as { id: string }
  conversationId = convData.id

  const msgRes = await tokenRequest(
    `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Inbox test message" }),
    },
  )
  const msgData = await msgRes.json() as { task?: { id: string } | null }
  if (msgData.task) {
    taskId = msgData.task.id
  }

  // Poll, start, and complete the task so it shows up in inbox
  await tokenRequest(`/api/daemon/tasks/poll`, seed.machineToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
  })
  await tokenRequest(`/api/daemon/tasks/${taskId}/start`, seed.machineToken, { method: "POST" })

  // Post an assistant message so the inbox query can find it
  await tokenRequest(
    `/api/daemon/tasks/${taskId}/messages`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ seq: 1, type: "text", content: "Task done" }],
      }),
    },
  )

  await tokenRequest(`/api/daemon/tasks/${taskId}/complete`, seed.machineToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ output: "done", session_id: "sess_inbox_1" }),
  })
})

afterAll(() => {
  sqlRun(`DELETE FROM conversation_read_state WHERE user_id = ?`, seed.userId)
  cleanupTestData(seed)
})

describe("GET /api/inbox/count", () => {
  it("returns unread count", async () => {
    const res = await tokenRequest(
      `/api/inbox/count?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { count: number }
    expect(typeof data.count).toBe("number")
  })

  it("rejects unauthenticated request", async () => {
    const res = await fetch(
      `${process.env.APP_URL || "http://localhost:3000"}/api/inbox/count?workspace_id=${seed.workspaceId}`,
    )
    expect(res.status).toBe(401)
  })
})

describe("GET /api/inbox", () => {
  it("returns inbox items list", async () => {
    const res = await tokenRequest(
      `/api/inbox?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { items: unknown[]; has_more: boolean }
    expect(Array.isArray(data.items)).toBe(true)
    expect(typeof data.has_more).toBe("boolean")
  })

  it("respects limit parameter", async () => {
    const res = await tokenRequest(
      `/api/inbox?workspace_id=${seed.workspaceId}&limit=1`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { items: unknown[] }
    expect(data.items.length).toBeLessThanOrEqual(1)
  })

  it("rejects invalid before timestamp", async () => {
    const res = await tokenRequest(
      `/api/inbox?workspace_id=${seed.workspaceId}&before=not-a-date`,
      seed.machineToken,
    )
    expect(res.status).toBe(400)
  })
})

describe("POST /api/inbox/read", () => {
  it("marks a conversation as read", async () => {
    const res = await tokenRequest(
      `/api/inbox/read?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      },
    )
    expect(res.status).toBe(204)
  })

  it("returns 400 when conversationId is missing", async () => {
    const res = await tokenRequest(
      `/api/inbox/read?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(400)
  })

  it("returns 404 for non-existent conversation", async () => {
    const res = await tokenRequest(
      `/api/inbox/read?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "conv_nonexistent_xyz" }),
      },
    )
    expect(res.status).toBe(404)
  })
})

describe("POST /api/inbox/read-all", () => {
  it("marks all conversations as read", async () => {
    const res = await tokenRequest(
      `/api/inbox/read-all?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(204)
  })

  it("rejects unauthenticated request", async () => {
    const res = await fetch(
      `${process.env.APP_URL || "http://localhost:3000"}/api/inbox/read-all?workspace_id=${seed.workspaceId}`,
      { method: "POST" },
    )
    expect(res.status).toBe(401)
  })
})
