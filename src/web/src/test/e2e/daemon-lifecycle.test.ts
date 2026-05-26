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

  it("POST /api/daemon/register creates runtimes and returns workspace_id", async () => {
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
            version: "4.0",
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { runtimes: Array<{ id: string }>; workspaceId: string }
    expect(data.runtimes).toHaveLength(1)
    expect(data.runtimes[0].id).toBeTruthy()
    expect(data.workspaceId).toBe(seed.workspaceId)
    registeredRuntimeId = data.runtimes[0].id
  })

  it("POST /api/daemon/register sets machine last_seen_at (online)", async () => {
    const rows = sqlQuery<{ last_seen_at: string | null }>(
      `SELECT last_seen_at FROM machine WHERE daemon_id = '${daemonId}' AND workspace_id = '${seed.workspaceId}'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.last_seen_at).toBeTruthy()
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

  it("register merges metadata (json_patch) instead of replacing", async () => {
    // First register sets cli_version
    const res1 = await tokenRequest("/api/daemon/register", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seed.workspaceId,
        daemon_id: daemonId,
        device_name: "e2e-machine",
        cli_version: "0.2.0",
        runtimes: [{ provider: "claude", runtime_mode: "local", version: "5.0" }],
      }),
    })
    expect(res1.status).toBe(200)

    // Verify cli_version is stored
    const rows1 = sqlQuery<{ metadata: string }>(
      `SELECT metadata FROM agent_runtime WHERE id = '${registeredRuntimeId}'`
    )
    const meta1 = JSON.parse(rows1[0]!.metadata)
    expect(meta1.cli_version).toBe("0.2.0")
    expect(meta1.version).toBe("5.0")

    // Second register without cli_version (simulates activate path)
    // We call register with empty cli_version — metadata should preserve cli_version
    const res2 = await tokenRequest("/api/daemon/register", seed.machineToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: seed.workspaceId,
        daemon_id: daemonId,
        device_name: "e2e-machine",
        cli_version: "",
        runtimes: [{ provider: "claude", runtime_mode: "local", version: "5.1" }],
      }),
    })
    expect(res2.status).toBe(200)

    // cli_version should still be preserved via json_patch merge
    const rows2 = sqlQuery<{ metadata: string }>(
      `SELECT metadata FROM agent_runtime WHERE id = '${registeredRuntimeId}'`
    )
    const meta2 = JSON.parse(rows2[0]!.metadata)
    expect(meta2.cli_version).toBe("0.2.0")
    expect(meta2.version).toBe("5.1")
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
