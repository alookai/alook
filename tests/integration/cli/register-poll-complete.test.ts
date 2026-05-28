import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import {
  seedTestData,
  cleanupTestData,
  type TestSeed,
  sqlRun,
  sqlQuery,
} from "@alook/test-utils"
import { DaemonClient } from "../../../src/cli/daemon/client"
import {
  RegisterResponseSchema,
  PollResponseSchema,
  TaskApiBaseSchema,
} from "@alook/shared"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const client = new DaemonClient(APP_URL)

let seed: TestSeed
const daemonId = `daemon_integ_${randomUUID().slice(0, 8)}`
let registeredRuntimeId: string
let conversationId: string
let taskId: string

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

describe("register → poll → start → messages → complete lifecycle", () => {
  it("register returns runtimes matching RegisterResponseSchema", async () => {
    const result = await client.register(seed.machineToken, {
      workspace_id: seed.workspaceId,
      daemon_id: daemonId,
      device_name: "integ-test-machine",
      cli_version: "0.1.0-integ",
      runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
    })

    const parsed = RegisterResponseSchema.safeParse(result)
    expect(parsed.success).toBe(true)
    expect(result.runtimes).toHaveLength(1)
    expect(result.runtimes[0].id).toBeTruthy()
    registeredRuntimeId = result.runtimes[0].id
  })

  it("poll with no queued tasks returns empty array matching PollResponseSchema", async () => {
    const result = await client.poll(seed.machineToken, daemonId, 1, "0.1.0-integ")
    const parsed = PollResponseSchema.safeParse({
      tasks: result.tasks,
      evicted: result.evicted,
      pending_update: result.pending_update,
      pending_rescan: result.pending_rescan,
      file_requests: result.file_requests,
      meetings: result.meetings,
    })
    expect(parsed.success).toBe(true)
    expect(result.tasks).toEqual([])
    expect(result.evicted).toBe(false)
  })

  it("poll claims a queued task", async () => {
    const now = new Date().toISOString()
    conversationId = `conv_${randomUUID().slice(0, 8)}`
    taskId = `task_${randomUUID().slice(0, 8)}`

    sqlRun(`INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, conversationId, seed.workspaceId, seed.agentId, seed.userId, 'integ test', now)
    sqlRun(`INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, status, type, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, taskId, seed.agentId, registeredRuntimeId, seed.workspaceId, conversationId, 'Hello integration test', 'queued', 'user_dm_message', now)

    const result = await client.poll(seed.machineToken, daemonId, 1, "0.1.0-integ")
    expect(result.tasks).toHaveLength(1)

    const task = result.tasks[0]
    expect(task.id).toBe(taskId)
    expect(task.prompt).toBe("Hello integration test")
    expect(task.status).toBe("dispatched")
    expect(task.workspace_id).toBe(seed.workspaceId)
  })

  it("start task transitions status to running and returns TaskApiBase shape", async () => {
    const result = await client.startTask(seed.machineToken, taskId) as Record<string, unknown>
    const parsed = TaskApiBaseSchema.safeParse(result)
    expect(parsed.success).toBe(true)
    expect(result.status).toBe("running")
    expect(result.started_at).toBeTruthy()
  })

  it("report messages stores them in DB", async () => {
    await client.reportMessages(seed.machineToken, taskId, [
      { seq: 1, type: "assistant", content: "Working on it..." },
      { seq: 2, type: "assistant", content: "Done!" },
    ])

    const rows = sqlQuery<{ seq: number; type: string; content: string }>(
      `SELECT seq, type, content FROM task_message WHERE task_id = ? ORDER BY seq`, taskId
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].content).toBe("Working on it...")
    expect(rows[1].content).toBe("Done!")
  })

  it("complete task transitions status and returns TaskApiBase shape", async () => {
    const result = await client.completeTask(seed.machineToken, taskId, {
      output: "Task completed successfully",
      session_id: "sess_integ_test",
    }) as Record<string, unknown>

    const parsed = TaskApiBaseSchema.safeParse(result)
    expect(parsed.success).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.completed_at).toBeTruthy()
  })

  it("DB reflects final state after completion", () => {
    const rows = sqlQuery<{ status: string; session_id: string | null; result: string | null }>(
      `SELECT status, session_id, result FROM agent_task_queue WHERE id = ?`, taskId
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("completed")
    expect(rows[0].session_id).toBe("sess_integ_test")
    expect(rows[0].result).toContain("Task completed successfully")
  })

  afterAll(() => {
    try {
      sqlRun(`DELETE FROM task_message WHERE task_id = ?`, taskId)
      sqlRun(`DELETE FROM agent_task_queue WHERE id = ?`, taskId)
      sqlRun(`DELETE FROM conversation WHERE id = ?`, conversationId)
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = ?`, daemonId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = ?`, daemonId)
    } catch { /* ignore */ }
  })
})
