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

  it("POST /api/daemon/tasks/poll claims the task", async () => {
    const res = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { tasks: Array<Record<string, unknown>> }
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].id).toBe(taskId)
    expect(data.tasks[0].status).toBe("dispatched")
    expect(data.tasks[0].prompt).toBe("Run the e2e tests")
    expect(data.tasks[0].context_key).toBe(conversationId)
    // Poll response includes agent data
    expect(data.tasks[0].agent).toBeTruthy()
    const agent = data.tasks[0].agent as Record<string, unknown>
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

  it("poll returns empty tasks when nothing queued", async () => {
    const res = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as { tasks: unknown[] }
    expect(data.tasks).toEqual([])
  })
})

describe("context_key resume contract", () => {
  let conv2Id: string
  let task2Id: string

  it("same conversation produces same context_key (DM resume)", async () => {
    // Complete the first task from the main beforeAll
    // (already completed above in the lifecycle tests)

    // Send another message in the SAME conversation
    const msgRes = await tokenRequest(
      `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Second message same conv" }),
      },
    )
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    expect(msgData.task).toBeTruthy()
    task2Id = msgData.task!.id

    // Poll to claim
    const pollRes = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
    )
    const pollData = await pollRes.json() as { tasks: Array<Record<string, unknown>> }
    expect(pollData.tasks).toHaveLength(1)
    // Same conversation → same context_key
    expect(pollData.tasks[0].context_key).toBe(conversationId)

    // Clean up: start + complete this task
    await tokenRequest(`/api/daemon/tasks/${task2Id}/start`, seed.machineToken, { method: "POST" })
    await tokenRequest(`/api/daemon/tasks/${task2Id}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "done", session_id: "sess_2" }),
    })
  })

  it("different conversation produces different context_key (DM reset)", async () => {
    // Create a NEW conversation (simulates reset)
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
    conv2Id = convData.id

    const msgRes = await tokenRequest(
      `/api/conversations/${conv2Id}/messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Message in new conv" }),
      },
    )
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    expect(msgData.task).toBeTruthy()

    const pollRes = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
    )
    const pollData = await pollRes.json() as { tasks: Array<Record<string, unknown>> }
    expect(pollData.tasks).toHaveLength(1)
    // Different conversation → different context_key
    expect(pollData.tasks[0].context_key).toBe(conv2Id)
    expect(pollData.tasks[0].context_key).not.toBe(conversationId)

    // Clean up
    const tid = pollData.tasks[0].id as string
    await tokenRequest(`/api/daemon/tasks/${tid}/start`, seed.machineToken, { method: "POST" })
    await tokenRequest(`/api/daemon/tasks/${tid}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "done", session_id: "sess_3" }),
    })
  })

  it("email notify with same thread root reuses same conversation via mapping", async () => {
    const threadRoot = `<root-${Date.now()}@e2e.test>`

    // First email in thread
    const res1 = await tokenRequest(
      `/api/email/notify?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: seed.agentId,
          workspaceId: seed.workspaceId,
          r2Key: "emails/fake1/raw",
          from: `${seed.userId}@test.local`,
          subject: "Thread email 1",
          isWhitelisted: true,
          messageId: threadRoot,
          inReplyTo: "",
          references: "",
        }),
      },
    )
    expect(res1.status).toBe(200)

    // Poll to get first task
    const poll1 = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
    )
    const poll1Data = await poll1.json() as { tasks: Array<Record<string, unknown>> }
    expect(poll1Data.tasks).toHaveLength(1)
    const emailConvId = poll1Data.tasks[0].context_key as string
    // context_key is now a conversation ID (not email:threadRoot)
    expect(emailConvId).toBeTruthy()
    expect(emailConvId).toBe(poll1Data.tasks[0].conversation_id)

    // Complete it
    const tid1 = poll1Data.tasks[0].id as string
    await tokenRequest(`/api/daemon/tasks/${tid1}/start`, seed.machineToken, { method: "POST" })
    await tokenRequest(`/api/daemon/tasks/${tid1}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "replied", session_id: "sess_email_1" }),
    })

    // Second email in same thread (references contains thread root)
    const res2 = await tokenRequest(
      `/api/email/notify?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: seed.agentId,
          workspaceId: seed.workspaceId,
          r2Key: "emails/fake2/raw",
          from: `${seed.userId}@test.local`,
          subject: "Re: Thread email 1",
          isWhitelisted: true,
          messageId: `<reply-${Date.now()}@e2e.test>`,
          inReplyTo: threadRoot,
          references: `${threadRoot} <reply-${Date.now()}@e2e.test>`,
        }),
      },
    )
    expect(res2.status).toBe(200)

    // Poll second task
    const poll2 = await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
    )
    const poll2Data = await poll2.json() as { tasks: Array<Record<string, unknown>> }
    expect(poll2Data.tasks).toHaveLength(1)
    // Same thread root → same conversation (via conversation_map lookup)
    expect(poll2Data.tasks[0].context_key).toBe(emailConvId)
    expect(poll2Data.tasks[0].conversation_id).toBe(emailConvId)

    // Clean up
    const tid2 = poll2Data.tasks[0].id as string
    await tokenRequest(`/api/daemon/tasks/${tid2}/start`, seed.machineToken, { method: "POST" })
    await tokenRequest(`/api/daemon/tasks/${tid2}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "replied again", session_id: "sess_email_2" }),
    })
  })
})

describe("task failure and retry", () => {
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

    // Claim and start the task via poll
    await tokenRequest(
      `/api/daemon/tasks/poll`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      },
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

  it("POST /api/tasks/:id/retry retries a failed task", async () => {
    const res = await tokenRequest(
      `/api/tasks/${failTaskId}/retry?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.status).toBe("queued")
    expect(data.prompt).toBe("This will fail")
    expect(data.id).not.toBe(failTaskId)
  })

  it("original task is now superseded", async () => {
    const res = await tokenRequest(
      `/api/tasks/${failTaskId}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.status).toBe("superseded")
  })

  it("retrying a non-failed task returns 400", async () => {
    // failTaskId is now superseded, not failed
    const res = await tokenRequest(
      `/api/tasks/${failTaskId}/retry?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "POST" },
    )
    expect(res.status).toBe(400)
    const data = await res.json() as Record<string, unknown>
    expect(data.error).toBe("only failed tasks can be retried")
  })
})
