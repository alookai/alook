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

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const client = new DaemonClient(APP_URL)

let seed: TestSeed
const daemonId = `daemon_sess_${randomUUID().slice(0, 8)}`
let runtimeId: string

beforeAll(async () => {
  seed = seedTestData()

  const reg = await client.register(seed.machineToken, {
    workspace_id: seed.workspaceId,
    daemon_id: daemonId,
    device_name: "session-test-machine",
    cli_version: "0.1.0-integ",
    runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
  })
  runtimeId = reg.runtimes[0].id
})
afterAll(() => cleanupTestData(seed))

describe("session resume via context_key", () => {
  const contextKey = `ctx_${randomUUID().slice(0, 8)}`
  const differentContextKey = `ctx_${randomUUID().slice(0, 8)}`
  let firstConversationId: string
  let firstTaskId: string
  let secondTaskId: string
  let thirdConversationId: string
  let thirdTaskId: string

  it("first task with context_key creates a new conversation", async () => {
    const now = new Date().toISOString()
    firstConversationId = `conv_${randomUUID().slice(0, 8)}`
    firstTaskId = `task_${randomUUID().slice(0, 8)}`

    sqlRun(`INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, firstConversationId, seed.workspaceId, seed.agentId, seed.userId, 'session resume test', now)
    sqlRun(`INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, status, type, context_key, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, firstTaskId, seed.agentId, runtimeId, seed.workspaceId, firstConversationId, 'First message', 'queued', 'user_dm_message', contextKey, now)

    const result = await client.poll(seed.machineToken, daemonId, 1, "0.1.0-integ")
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].id).toBe(firstTaskId)
    expect(result.tasks[0].context_key).toBe(contextKey)
    expect(result.tasks[0].conversation_id).toBe(firstConversationId)

    // Complete the first task with a session_id
    await client.startTask(seed.machineToken, firstTaskId)
    await client.completeTask(seed.machineToken, firstTaskId, {
      output: "First task done",
      session_id: "sess_first",
    })
  })

  it("second task with same context_key uses same conversation", async () => {
    const now = new Date().toISOString()
    secondTaskId = `task_${randomUUID().slice(0, 8)}`

    sqlRun(`INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, status, type, context_key, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, secondTaskId, seed.agentId, runtimeId, seed.workspaceId, firstConversationId, 'Second message same context', 'queued', 'user_dm_message', contextKey, now)

    const result = await client.poll(seed.machineToken, daemonId, 1, "0.1.0-integ")
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].id).toBe(secondTaskId)
    expect(result.tasks[0].context_key).toBe(contextKey)
    expect(result.tasks[0].conversation_id).toBe(firstConversationId)

    await client.startTask(seed.machineToken, secondTaskId)
    await client.completeTask(seed.machineToken, secondTaskId, {
      output: "Second task done",
      session_id: "sess_first",
    })
  })

  it("task with different context_key uses a different conversation", async () => {
    const now = new Date().toISOString()
    thirdConversationId = `conv_${randomUUID().slice(0, 8)}`
    thirdTaskId = `task_${randomUUID().slice(0, 8)}`

    sqlRun(`INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, thirdConversationId, seed.workspaceId, seed.agentId, seed.userId, 'different context', now)
    sqlRun(`INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, status, type, context_key, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, thirdTaskId, seed.agentId, runtimeId, seed.workspaceId, thirdConversationId, 'Different context message', 'queued', 'user_dm_message', differentContextKey, now)

    const result = await client.poll(seed.machineToken, daemonId, 1, "0.1.0-integ")
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].id).toBe(thirdTaskId)
    expect(result.tasks[0].context_key).toBe(differentContextKey)
    expect(result.tasks[0].conversation_id).toBe(thirdConversationId)
    expect(result.tasks[0].conversation_id).not.toBe(firstConversationId)
  })

  it("DB shows different session_ids for different context_keys", async () => {
    await client.startTask(seed.machineToken, thirdTaskId)
    await client.completeTask(seed.machineToken, thirdTaskId, {
      output: "Third task done",
      session_id: "sess_different",
    })

    const rows = sqlQuery<{ id: string; context_key: string | null; session_id: string | null; conversation_id: string }>(
      `SELECT id, context_key, session_id, conversation_id FROM agent_task_queue WHERE id IN (?, ?, ?) ORDER BY created_at`, firstTaskId, secondTaskId, thirdTaskId
    )
    expect(rows).toHaveLength(3)

    // First two tasks share conversation and context_key
    expect(rows[0].context_key).toBe(contextKey)
    expect(rows[1].context_key).toBe(contextKey)
    expect(rows[0].conversation_id).toBe(rows[1].conversation_id)
    expect(rows[0].session_id).toBe("sess_first")
    expect(rows[1].session_id).toBe("sess_first")

    // Third task has different context_key and conversation
    expect(rows[2].context_key).toBe(differentContextKey)
    expect(rows[2].conversation_id).not.toBe(rows[0].conversation_id)
    expect(rows[2].session_id).toBe("sess_different")
  })

  afterAll(() => {
    try {
      sqlRun(`DELETE FROM agent_task_queue WHERE id IN (?, ?, ?)`, firstTaskId, secondTaskId, thirdTaskId)
      sqlRun(`DELETE FROM conversation WHERE id IN (?, ?)`, firstConversationId, thirdConversationId)
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = ?`, daemonId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = ?`, daemonId)
    } catch { /* ignore */ }
  })
})
