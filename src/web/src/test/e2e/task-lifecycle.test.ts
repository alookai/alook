import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"

let seed: TestSeed
let conversationId: string
let taskId: string

beforeAll(async () => {
  seed = seedTestData()

  // Create a conversation
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

  // Send a message to enqueue a task
  const msgRes = await tokenRequest(
    `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Run the e2e tests" }),
    },
  )
  const msgData = await msgRes.json() as { task?: { id: string } | null }
  if (msgData.task) {
    taskId = msgData.task.id
  }
})

afterAll(() => cleanupTestData(seed))

describe("task lifecycle", () => {
  it("message enqueue creates a task", () => {
    expect(taskId).toBeTruthy()
  })

  it("POST /api/daemon/runtimes/:id/tasks/claim claims the task", async () => {
    const res = await tokenRequest(
      `/api/daemon/runtimes/${seed.runtimeId}/tasks/claim`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { task: Record<string, unknown> | null }
    expect(data.task).not.toBeNull()
    expect(data.task!.id).toBe(taskId)
    expect(data.task!.status).toBe("dispatched")
    expect(data.task!.prompt).toBe("Run the e2e tests")
    // Claim response includes agent data
    expect(data.task!.agent).toBeTruthy()
    const agent = data.task!.agent as Record<string, unknown>
    expect(agent.name).toBe("Test Agent")
  })

  it("POST /api/daemon/tasks/:id/start marks task as running", async () => {
    const res = await tokenRequest(
      `/api/daemon/tasks/${taskId}/start`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.status).toBe("running")
    expect(data.started_at).toBeTruthy()
  })

  it("POST /api/daemon/tasks/:id/messages stores messages", async () => {
    const res = await tokenRequest(
      `/api/daemon/tasks/${taskId}/messages`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { seq: 1, type: "text", content: "Running tests..." },
            { seq: 2, type: "tool", tool: "bash", content: "pnpm test", output: "All tests passed" },
          ],
        }),
      },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { status: string }
    expect(data.status).toBe("ok")
  })

  it("GET /api/daemon/tasks/:id/messages returns stored messages", async () => {
    // Small delay to allow async message creation to complete
    await new Promise(r => setTimeout(r, 500))

    const res = await tokenRequest(
      `/api/daemon/tasks/${taskId}/messages`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.length).toBeGreaterThanOrEqual(2)
    expect(data.some(m => m.content === "Running tests...")).toBe(true)
    expect(data.some(m => m.tool === "bash")).toBe(true)
  })

  it("POST /api/daemon/tasks/:id/complete marks task complete", async () => {
    const res = await tokenRequest(
      `/api/daemon/tasks/${taskId}/complete`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          output: "All tests passed",
          session_id: "sess_test_123",
        }),
      },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.status).toBe("completed")
    expect(data.completed_at).toBeTruthy()
  })

  it("GET /api/tasks/:id returns task (workspace auth)", async () => {
    const res = await tokenRequest(
      `/api/tasks/${taskId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBe(taskId)
    expect(data.status).toBe("completed")
  })

  it("claim returns null when no tasks queued", async () => {
    const res = await tokenRequest(
      `/api/daemon/runtimes/${seed.runtimeId}/tasks/claim`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { task: unknown }
    expect(data.task).toBeNull()
  })
})

describe("task failure", () => {
  let failTaskId: string

  beforeAll(async () => {
    // Create another conversation + message to get a new task
    const convRes = await tokenRequest(
      `/api/conversations?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: seed.agentId }),
      },
    )
    const { id: convId } = await convRes.json() as { id: string }

    const msgRes = await tokenRequest(
      `/api/conversations/${convId}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "This will fail" }),
      },
    )
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    if (msgData.task) {
      failTaskId = msgData.task.id
    }

    // Claim and start the task
    await tokenRequest(
      `/api/daemon/runtimes/${seed.runtimeId}/tasks/claim`,
      seed.machineToken,
      { method: "POST" },
    )
    await tokenRequest(
      `/api/daemon/tasks/${failTaskId}/start`,
      seed.machineToken,
      { method: "POST" },
    )
  })

  it("POST /api/daemon/tasks/:id/fail marks task failed", async () => {
    const res = await tokenRequest(
      `/api/daemon/tasks/${failTaskId}/fail`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Timeout exceeded" }),
      },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.status).toBe("failed")
    expect(data.error).toBe("Timeout exceeded")
  })
})
