/**
 * Regression: Follow-up messages auto-dispatch after task completion
 * Bug pattern: Buffered messages sent during an active task were not automatically
 * dispatched as a new task when the active task completed.
 * Refs: #194 (Priority 2)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlQuery } from "@alook/test-utils"

let seed: TestSeed
let conversationId: string
let firstTaskId: string

beforeAll(async () => {
  seed = seedTestData()

  // Create conversation and first task
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

  // Send initial message → creates first task
  const msgRes = await tokenRequest(
    `/api/conversations/${conversationId}/messages?workspace_id=${seed.workspaceId}`,
    seed.machineToken,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Initial task" }),
    },
  )
  const msgData = await msgRes.json() as { task?: { id: string } | null }
  firstTaskId = msgData.task!.id

  // Poll + start the task
  await tokenRequest(`/api/daemon/tasks/poll`, seed.machineToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
  })
  await tokenRequest(`/api/daemon/tasks/${firstTaskId}/start`, seed.machineToken, { method: "POST" })
})
afterAll(() => cleanupTestData(seed))

describe("regression: follow-up auto-dispatch on task completion", () => {
  it("buffered messages are created while task is running", async () => {
    const buf1Res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Follow-up message 1" }),
      },
    )
    expect(buf1Res.status).toBe(201)

    const buf2Res = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Follow-up message 2" }),
      },
    )
    expect(buf2Res.status).toBe(201)

    // Verify they exist as buffered
    const listRes = await tokenRequest(
      `/api/conversations/${conversationId}/buffered-messages?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    const buffered = await listRes.json() as Array<Record<string, unknown>>
    expect(buffered.length).toBeGreaterThanOrEqual(2)
  })

  it("completing first task auto-dispatches a new task with first buffered message", async () => {
    const completeRes = await tokenRequest(
      `/api/daemon/tasks/${firstTaskId}/complete`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output: "First task done", session_id: `sess_${randomUUID().slice(0, 8)}` }),
      },
    )
    expect(completeRes.status).toBe(200)

    // Wait for auto-dispatch
    await new Promise((r) => setTimeout(r, 1500))

    // There should be a new task created with the buffered content
    const tasks = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM agent_task_queue WHERE conversation_id = '${conversationId}' AND id != '${firstTaskId}' AND status IN ('queued', 'dispatched') ORDER BY created_at ASC`,
    )
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    expect(tasks[0].prompt).toBe("Follow-up message 1")
    expect(tasks[0].type).toBe("user_dm_message")
  })

  it("second buffered message dispatches after the first follow-up completes", async () => {
    // Find and complete the auto-dispatched task
    const tasks = sqlQuery<{ id: string; status: string }>(
      `SELECT id, status FROM agent_task_queue WHERE conversation_id = '${conversationId}' AND prompt = 'Follow-up message 1'`,
    )
    expect(tasks).toHaveLength(1)
    const followUpTaskId = tasks[0].id

    // Poll + start + complete
    if (tasks[0].status === "queued") {
      await tokenRequest(`/api/daemon/tasks/poll`, seed.machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daemon_id: seed.daemonId, max_tasks: 1 }),
      })
    }
    await tokenRequest(`/api/daemon/tasks/${followUpTaskId}/start`, seed.machineToken, { method: "POST" })
    await tokenRequest(`/api/daemon/tasks/${followUpTaskId}/complete`, seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "Follow-up 1 done", session_id: `sess_${randomUUID().slice(0, 8)}` }),
    })

    // Wait for second follow-up dispatch
    await new Promise((r) => setTimeout(r, 1500))

    const tasks2 = sqlQuery<Record<string, unknown>>(
      `SELECT * FROM agent_task_queue WHERE conversation_id = '${conversationId}' AND prompt = 'Follow-up message 2'`,
    )
    expect(tasks2.length).toBeGreaterThanOrEqual(1)
    expect(tasks2[0].type).toBe("user_dm_message")
  })
})
