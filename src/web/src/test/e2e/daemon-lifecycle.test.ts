import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed } from "../helpers/seed"
import { tokenRequest } from "../helpers/auth"
import { sqlQuery, sqlBatch } from "../helpers/db"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

describe("daemon lifecycle", () => {
  const daemonId = `daemon_e2e_${randomUUID().slice(0, 8)}`
  let registeredRuntimeId: string

  it("POST /api/daemon/register creates runtimes", async () => {
    const res = await tokenRequest("/api/daemon/register", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seed.workspaceId,
        daemon_id: daemonId,
        device_name: "e2e-machine",
        cli_version: "0.1.0-test",
        runtimes: [
          {
            provider: "claude",
            runtime_mode: "local",
            name: "Claude E2E",
            version: "4.0",
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { runtimes: Array<{ id: string }> }
    expect(data.runtimes).toHaveLength(1)
    expect(data.runtimes[0].id).toBeTruthy()
    registeredRuntimeId = data.runtimes[0].id
  })

  it("POST /api/daemon/register is idempotent (upserts)", async () => {
    const res = await tokenRequest("/api/daemon/register", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seed.workspaceId,
        daemon_id: daemonId,
        device_name: "e2e-machine",
        cli_version: "0.1.0-test",
        runtimes: [
          {
            provider: "claude",
            runtime_mode: "local",
            name: "Claude E2E Updated",
            version: "4.1",
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { runtimes: Array<{ id: string }> }
    // Same runtime ID (upsert by workspace_id + daemon_id + provider)
    expect(data.runtimes[0].id).toBe(registeredRuntimeId)
  })

  it("POST /api/daemon/tasks/poll updates last_seen_at", async () => {
    const res = await tokenRequest("/api/daemon/tasks/poll", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: daemonId }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { tasks: unknown[] }
    expect(data.tasks).toEqual([])

    // Verify machine last_seen_at was set in DB
    const rows = sqlQuery<{ last_seen_at: string }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = '${daemonId}' AND workspace_id = '${seed.workspaceId}'`
    )
    expect(rows[0]?.last_seen_at).toBeTruthy()
  })

  it("POST /api/daemon/tasks/poll rejects without machine token", async () => {
    const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
    const res = await fetch(`${APP_URL}/api/daemon/tasks/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: daemonId }),
    })
    expect(res.status).toBe(401)
  })

  it("POST /api/daemon/deregister sets machine offline", async () => {
    const res = await tokenRequest("/api/daemon/deregister", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: daemonId }),
    })
    expect(res.status).toBe(200)

    // Verify machine last_seen_at is null (offline)
    const rows = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = '${daemonId}' AND workspace_id = '${seed.workspaceId}'`
    )
    expect(rows[0]?.last_seen_at).toBeNull()
  })

  afterAll(() => {
    try {
      sqlBatch([
        `DELETE FROM agent_runtime WHERE daemon_id = '${daemonId}'`,
        `DELETE FROM machine WHERE daemon_id = '${daemonId}'`,
      ])
    } catch { /* ignore */ }
  })
})
