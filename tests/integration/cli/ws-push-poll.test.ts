import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import {
  seedTestData,
  cleanupTestData,
  type TestSeed,
  sqlRun,
} from "@alook/test-utils"
import { DaemonClient } from "../../../src/cli/daemon/client"
import { DaemonPushMessageSchema } from "@alook/shared"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const WS_DO_URL = process.env.WS_DO_URL ?? "http://localhost:8789"
const client = new DaemonClient(APP_URL)

let seed: TestSeed
const daemonId = `daemon_ws_${randomUUID().slice(0, 8)}`
let runtimeId: string
let wsAvailable = false

beforeAll(async () => {
  seed = seedTestData()

  // Check if WS-DO is available
  try {
    const res = await fetch(WS_DO_URL, { signal: AbortSignal.timeout(2000) })
    wsAvailable = res.status !== 0
  } catch {
    wsAvailable = false
  }

  const reg = await client.register(seed.machineToken, {
    workspace_id: seed.workspaceId,
    daemon_id: daemonId,
    device_name: "ws-test-machine",
    cli_version: "0.1.0-integ",
    runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
  })
  runtimeId = reg.runtimes[0].id
})
afterAll(() => cleanupTestData(seed))

describe("WebSocket push → poll", () => {
  it.skipIf(!wsAvailable)("daemon.tasks push triggers immediate poll with correct task", async () => {
    const now = new Date().toISOString()
    const conversationId = `conv_ws_${randomUUID().slice(0, 8)}`
    const taskId = `task_ws_${randomUUID().slice(0, 8)}`

    sqlRun(`INSERT INTO conversation (id, workspace_id, agent_id, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, conversationId, seed.workspaceId, seed.agentId, seed.userId, 'ws push test', now)
    sqlRun(`INSERT INTO agent_task_queue (id, agent_id, runtime_id, workspace_id, conversation_id, prompt, status, type, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`, taskId, seed.agentId, runtimeId, seed.workspaceId, conversationId, 'WS push test prompt', 'queued', 'user_dm_message', now)

    // Connect WebSocket and wait for push message
    const wsUrl = `${WS_DO_URL.replace("http", "ws")}/ws/daemon?token=${seed.machineToken}&daemon_id=${daemonId}`
    const ws = new WebSocket(wsUrl)

    const pushMessage = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error("WebSocket push timeout — no daemon.tasks message received within 10s"))
      }, 10_000)

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string)
          if (data.type === "daemon.tasks") {
            clearTimeout(timeout)
            ws.close()
            resolve(data)
          }
        } catch { /* ignore non-JSON frames */ }
      }
      ws.onerror = (err) => {
        clearTimeout(timeout)
        reject(err)
      }
    })

    const parsed = DaemonPushMessageSchema.safeParse(pushMessage)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.type === "daemon.tasks") {
      expect(parsed.data.tasks.length).toBeGreaterThanOrEqual(1)
      const pushed = parsed.data.tasks.find((t) => t.id === taskId)
      expect(pushed).toBeDefined()
    }

    // Poll should also return the task
    const pollResult = await client.poll(seed.machineToken, daemonId, 1)
    expect(pollResult.tasks.length).toBeGreaterThanOrEqual(1)

    // Cleanup
    sqlRun(`DELETE FROM agent_task_queue WHERE id = ?`, taskId)
    sqlRun(`DELETE FROM conversation WHERE id = ?`, conversationId)
  })

  afterAll(() => {
    try {
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = ?`, daemonId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = ?`, daemonId)
    } catch { /* ignore */ }
  })
})
