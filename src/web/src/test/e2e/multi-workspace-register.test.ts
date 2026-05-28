/**
 * Regression: Register daemon across multiple workspaces
 * Bug pattern: Registering the same daemon_id in workspace B caused workspace A
 * to go offline, breaking task routing for existing workspace.
 * Refs: #194 (Priority 1)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun, sqlQuery } from "@alook/test-utils"

let seedA: TestSeed
let seedB: TestSeed
const sharedDaemonId = `daemon_multi_${randomUUID().slice(0, 8)}`

beforeAll(() => {
  seedA = seedTestData()
  seedB = seedTestData()
})
afterAll(() => {
  // Restore agent runtime_id to seed's original runtime before cleanup
  // (test may have pointed it to the shared daemon's runtime)
  sqlRun(`UPDATE agent SET runtime_id = ? WHERE id = ?`, seedA.runtimeId, seedA.agentId)
  // Clean up tasks referencing the shared daemon's runtime
  sqlRun(`DELETE FROM agent_task_queue WHERE workspace_id = ?`, seedA.workspaceId)
  sqlRun(`DELETE FROM agent_task_queue WHERE workspace_id = ?`, seedB.workspaceId)
  // Clean the shared daemon entries
  sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = ?`, sharedDaemonId)
  sqlRun(`DELETE FROM machine WHERE daemon_id = ?`, sharedDaemonId)
  cleanupTestData(seedA)
  cleanupTestData(seedB)
})

describe("regression: multi-workspace daemon registration", () => {
  it("register daemon in workspace A → machine is online", async () => {
    const res = await tokenRequest("/api/daemon/register", seedA.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seedA.workspaceId,
        daemon_id: sharedDaemonId,
        device_name: "multi-ws-device",
        cli_version: "1.0.0",
        runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(200)

    const rows = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = ? AND workspace_id = ?`, sharedDaemonId, seedA.workspaceId
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].last_seen_at).toBeTruthy()
  })

  it("register same daemon in workspace B → workspace A still online", async () => {
    const res = await tokenRequest("/api/daemon/register", seedB.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seedB.workspaceId,
        daemon_id: sharedDaemonId,
        device_name: "multi-ws-device",
        cli_version: "1.0.0",
        runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(200)

    // Workspace A machine should still be online
    const rowsA = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = ? AND workspace_id = ?`, sharedDaemonId, seedA.workspaceId
    )
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0].last_seen_at).toBeTruthy()

    // Workspace B machine should also be online
    const rowsB = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = ? AND workspace_id = ?`, sharedDaemonId, seedB.workspaceId
    )
    expect(rowsB).toHaveLength(1)
    expect(rowsB[0].last_seen_at).toBeTruthy()
  })

  it("tasks route correctly to workspace A after workspace B registration", async () => {
    // Get runtime ID for workspace A
    const runtimesA = sqlQuery<{ id: string }>(
      `SELECT id FROM agent_runtime WHERE daemon_id = ? AND workspace_id = ?`, sharedDaemonId, seedA.workspaceId
    )
    expect(runtimesA).toHaveLength(1)
    const runtimeIdA = runtimesA[0].id

    // Update agent A to use this runtime
    sqlRun(`UPDATE agent SET runtime_id = ? WHERE id = ?`, runtimeIdA, seedA.agentId)

    // Create a task in workspace A
    const convRes = await tokenRequest(
      `/api/conversations?workspace_id=${seedA.workspaceId}`,
      seedA.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: seedA.agentId }),
      },
    )
    const { id: convId } = await convRes.json() as { id: string }

    const msgRes = await tokenRequest(
      `/api/conversations/${convId}/messages?workspace_id=${seedA.workspaceId}`,
      seedA.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Route to workspace A" }),
      },
    )
    expect(msgRes.status).toBe(201)
    const msgData = await msgRes.json() as { task?: { id: string } | null }
    expect(msgData.task).toBeTruthy()

    // Poll from workspace A daemon to claim the task
    const pollRes = await tokenRequest(`/api/daemon/tasks/poll`, seedA.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: sharedDaemonId, max_tasks: 5 }),
    })
    expect(pollRes.status).toBe(200)
    const pollData = await pollRes.json() as { tasks: Array<Record<string, unknown>> }
    expect(pollData.tasks.length).toBeGreaterThanOrEqual(1)
    const claimed = pollData.tasks.find(t => t.id === msgData.task!.id)
    expect(claimed).toBeTruthy()
    expect(claimed!.prompt).toBe("Route to workspace A")

    // Cleanup: complete the task
    await tokenRequest(`/api/daemon/tasks/${msgData.task!.id}/start`, seedA.machineToken, { method: "POST" })
    await tokenRequest(`/api/daemon/tasks/${msgData.task!.id}/complete`, seedA.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "done", session_id: "sess_multi" }),
    })
  })

  it("deregister from workspace B does NOT affect workspace A", async () => {
    await tokenRequest("/api/daemon/deregister", seedB.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: sharedDaemonId }),
    })

    // Workspace B offline
    const rowsB = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = ? AND workspace_id = ?`, sharedDaemonId, seedB.workspaceId
    )
    expect(rowsB[0]?.last_seen_at).toBeNull()

    // Workspace A still online
    const rowsA = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = ? AND workspace_id = ?`, sharedDaemonId, seedA.workspaceId
    )
    expect(rowsA[0]?.last_seen_at).toBeTruthy()
  })
})
