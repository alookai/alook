/**
 * Regression: Task state transition validation
 * Bug pattern: Invalid state transitions (e.g., failing a queued task, completing
 * an already-completed task, starting a completed task) were not properly rejected.
 * Refs: #194 (Priority 3)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun, sqlQuery } from "@alook/test-utils"

describe("regression: invalid task state transitions return 400", () => {
  let seed: TestSeed

  beforeAll(() => {
    seed = seedTestData()
  })
  afterAll(() => cleanupTestData(seed))

  async function createAndEnqueueTask(): Promise<string> {
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
        body: JSON.stringify({ content: `State test ${randomUUID().slice(0, 8)}` }),
      },
    )
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    return msgData.task!.id
  }

  async function getTaskToRunning(): Promise<string> {
    const taskId = await createAndEnqueueTask()
    // Poll to dispatch
    await tokenRequest(`/api/daemon/tasks/poll`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 10 }),
    })
    // Start
    await tokenRequest(`/api/daemon/tasks/${taskId}/start`, seed.machineToken, { method: "POST" })
    return taskId
  }

  async function getTaskToCompleted(): Promise<string> {
    const taskId = await getTaskToRunning()
    await tokenRequest(`/api/daemon/tasks/${taskId}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "done", session_id: `sess_${randomUUID().slice(0, 8)}` }),
    })
    return taskId
  }

  async function getTaskToFailed(): Promise<string> {
    const taskId = await getTaskToRunning()
    await tokenRequest(`/api/daemon/tasks/${taskId}/fail`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "intentional" }),
    })
    return taskId
  }

  it("cannot fail a queued task (must be running first)", async () => {
    const taskId = await createAndEnqueueTask()
    // Force queued status in case push dispatched it
    sqlRun(`UPDATE agent_task_queue SET status = ? WHERE id = ?`, 'queued', taskId)

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/fail`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "should not work" }),
    })
    expect(res.status).toBe(400)
  })

  it("cannot complete a queued task", async () => {
    const taskId = await createAndEnqueueTask()
    sqlRun(`UPDATE agent_task_queue SET status = ? WHERE id = ?`, 'queued', taskId)

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "nope", session_id: "sess_x" }),
    })
    expect(res.status).toBe(400)
  })

  it("cannot complete an already-completed task", async () => {
    const taskId = await getTaskToCompleted()

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "again", session_id: "sess_y" }),
    })
    expect(res.status).toBe(400)
  })

  it("cannot start a completed task", async () => {
    const taskId = await getTaskToCompleted()

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/start`, seed.machineToken, { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("cannot start a failed task", async () => {
    const taskId = await getTaskToFailed()

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/start`, seed.machineToken, { method: "POST" })
    expect(res.status).toBe(400)
  })

  it("cannot fail an already-failed task", async () => {
    const taskId = await getTaskToFailed()

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/fail`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "double fail" }),
    })
    expect(res.status).toBe(400)
  })

  it("cannot fail an already-completed task", async () => {
    const taskId = await getTaskToCompleted()

    const res = await tokenRequest(`/api/daemon/tasks/${taskId}/fail`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "too late" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("regression: valid task state transitions succeed", () => {
  let seed: TestSeed

  beforeAll(() => {
    seed = seedTestData()
  })
  afterAll(() => cleanupTestData(seed))

  it("dispatched → start → complete", async () => {
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
        body: JSON.stringify({ content: `Valid start-complete ${randomUUID().slice(0, 8)}` }),
      },
    )
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    const taskId = msgData.task!.id

    // Poll to claim
    const pollRes = await tokenRequest(`/api/daemon/tasks/poll`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
    })
    expect(pollRes.status).toBe(200)
    const pollData = await pollRes.json() as { tasks: Array<{ id: string; status: string }> }
    expect(pollData.tasks).toHaveLength(1)
    expect(pollData.tasks[0].id).toBe(taskId)
    expect(pollData.tasks[0].status).toBe("dispatched")

    const startRes = await tokenRequest(`/api/daemon/tasks/${taskId}/start`, seed.machineToken, { method: "POST" })
    expect(startRes.status).toBe(200)

    const completeRes = await tokenRequest(`/api/daemon/tasks/${taskId}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "success", session_id: `sess_${randomUUID().slice(0, 8)}` }),
    })
    expect(completeRes.status).toBe(200)
  })

  it("dispatched → start → fail", async () => {
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
        body: JSON.stringify({ content: `Valid start-fail ${randomUUID().slice(0, 8)}` }),
      },
    )
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    const taskId = msgData.task!.id

    // Poll to claim
    const pollRes = await tokenRequest(`/api/daemon/tasks/poll`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
    })
    expect(pollRes.status).toBe(200)
    const pollData = await pollRes.json() as { tasks: Array<{ id: string }> }
    expect(pollData.tasks).toHaveLength(1)
    expect(pollData.tasks[0].id).toBe(taskId)

    const startRes = await tokenRequest(`/api/daemon/tasks/${taskId}/start`, seed.machineToken, { method: "POST" })
    expect(startRes.status).toBe(200)

    const failRes = await tokenRequest(`/api/daemon/tasks/${taskId}/fail`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "expected failure" }),
    })
    expect(failRes.status).toBe(200)
  })
})
