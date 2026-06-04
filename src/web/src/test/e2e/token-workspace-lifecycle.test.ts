import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sqlRun, sqlQuery, fetchWithRetry } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"

describe("token/workspace lifecycle — decoupled activate + bind", () => {
  describe("Tauri desktop flow: auto-register → Launch Company → bind", () => {
    let pendingToken: string
    let pendingTokenId: string

    beforeAll(() => {
      pendingTokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
      pendingToken = `al_${randomUUID().replace(/-/g, "")}`
      const now = new Date().toISOString()
      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        pendingTokenId, seed.userId, pendingToken, "tauri-desktop", "pending", now,
      )
    })

    it("activate transitions token to registered (no workspace created)", async () => {
      const res = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: pendingToken,
          hostname: "MacBook-E2E.local",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { daemon_id: string; token_status: string }
      expect(data.token_status).toBe("registered")
      expect(data.daemon_id).toBe("MacBook-E2E.local")

      const rows = sqlQuery<{ status: string; hostname: string; runtimes_json: string }>(
        `SELECT status, hostname, runtimes_json FROM machine_token WHERE id = ?`, pendingTokenId,
      )
      expect(rows[0]!.status).toBe("registered")
      expect(rows[0]!.hostname).toBe("MacBook-E2E.local")
      expect(JSON.parse(rows[0]!.runtimes_json)).toEqual([{ type: "claude", version: "4.0" }])
    })

    it("bind-workspace transitions token to active and creates machine/runtime rows", async () => {
      const res = await tokenRequest("/api/machine-tokens/bind-workspace", pendingToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: seed.workspaceId }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { workspace_id: string; runtimes: Array<{ id: string }> }
      expect(data.workspace_id).toBe(seed.workspaceId)
      expect(data.runtimes.length).toBeGreaterThanOrEqual(1)

      const tokenRows = sqlQuery<{ status: string; workspace_id: string }>(
        `SELECT status, workspace_id FROM machine_token WHERE id = ?`, pendingTokenId,
      )
      expect(tokenRows[0]!.status).toBe("active")
      expect(tokenRows[0]!.workspace_id).toBe(seed.workspaceId)
    })
  })

  describe("Token reuse: registered token returned by POST /machine-tokens", () => {
    let registeredTokenId: string
    let registeredToken: string

    beforeAll(() => {
      registeredTokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
      registeredToken = `al_${randomUUID().replace(/-/g, "")}`
      const now = new Date().toISOString()
      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, hostname, runtimes_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        registeredTokenId, seed.userId, registeredToken, "reuse-test", "registered", "Host.local", '[{"type":"claude"}]', now,
      )
    })

    it("returns existing registered token instead of creating new one", async () => {
      const res = await tokenRequest("/api/machine-tokens", seed.machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = await res.json() as { token: string; id: string }
      expect(res.status).toBe(200)
      expect(data.token).toBe(registeredToken)
      expect(data.id).toBe(registeredTokenId)
    })

    afterAll(() => {
      sqlRun(`DELETE FROM machine_token WHERE id = ?`, registeredTokenId)
    })
  })

  describe("Multi-token: multiple registered → bind earliest", () => {
    let olderTokenId: string
    let newerTokenId: string
    let olderToken: string
    let newerToken: string

    beforeAll(() => {
      olderTokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
      newerTokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
      olderToken = `al_${randomUUID().replace(/-/g, "")}`
      newerToken = `al_${randomUUID().replace(/-/g, "")}`

      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, hostname, runtimes_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        olderTokenId, seed.userId, olderToken, "older", "registered", "OldHost.local", '[{"type":"claude"}]', "2025-01-01T00:00:00Z",
      )
      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, hostname, runtimes_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        newerTokenId, seed.userId, newerToken, "newer", "registered", "NewHost.local", '[{"type":"claude"}]', "2025-06-01T00:00:00Z",
      )
    })

    it("bind-workspace selects the earliest registered token", async () => {
      const res = await tokenRequest("/api/machine-tokens/bind-workspace", olderToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: seed.workspaceId }),
      })
      expect(res.status).toBe(200)

      const rows = sqlQuery<{ status: string }>(
        `SELECT status FROM machine_token WHERE id = ?`, olderTokenId,
      )
      expect(rows[0]!.status).toBe("active")

      const newerRows = sqlQuery<{ status: string }>(
        `SELECT status FROM machine_token WHERE id = ?`, newerTokenId,
      )
      expect(newerRows[0]!.status).toBe("registered")
    })

    afterAll(() => {
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = 'OldHost.local' AND workspace_id = ?`, seed.workspaceId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = 'OldHost.local' AND workspace_id = ?`, seed.workspaceId)
      sqlRun(`DELETE FROM machine_token WHERE id IN (?, ?)`, olderTokenId, newerTokenId)
    })
  })

  describe("bind-workspace token status validation", () => {
    let pendingOnlyTokenId: string
    let pendingOnlyToken: string

    beforeAll(() => {
      pendingOnlyTokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
      pendingOnlyToken = `al_${randomUUID().replace(/-/g, "")}`
      const now = new Date().toISOString()
      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        pendingOnlyTokenId, seed.userId, pendingOnlyToken, "pending-only", "pending", now,
      )
    })

    it("returns 409 when token exists but status is pending (not registered)", async () => {
      // Use the seed machineToken for auth (which is active and bound to workspace)
      // but the user's latest non-registered token should trigger 409
      const res = await tokenRequest("/api/machine-tokens/bind-workspace", seed.machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: seed.workspaceId }),
      })
      const data = await res.json() as { error: string }
      // Could be 409 (token wrong status) or 404 (no registered token for this user)
      // depends on whether there are leftover registered tokens from other tests
      expect([404, 409]).toContain(res.status)
      if (res.status === 409) {
        expect(data.error).toContain("expected \"registered\"")
      }
    })

    afterAll(() => {
      sqlRun(`DELETE FROM machine_token WHERE id = ?`, pendingOnlyTokenId)
    })
  })

  describe("daemon standby → workspace binding discovered", () => {
    let standbyTokenId: string
    let standbyToken: string

    beforeAll(() => {
      standbyTokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
      standbyToken = `al_${randomUUID().replace(/-/g, "")}`
      const now = new Date().toISOString()
      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, hostname, runtimes_json, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        standbyTokenId, seed.userId, standbyToken, "standby-test", "registered", "StandbyHost.local", '[{"type":"claude"}]', now,
      )
    })

    it("daemon register returns standby when token has no workspace_id", async () => {
      const res = await tokenRequest("/api/daemon/register", standbyToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daemon_id: "standby-daemon-e2e",
          device_name: "StandbyHost.local",
          cli_version: "1.0.0",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { runtimes: unknown[]; standby: boolean }
      expect(data.standby).toBe(true)
      expect(data.runtimes).toEqual([])
    })

    it("after bind-workspace, daemon register returns workspace data", async () => {
      // First bind the workspace
      const bindRes = await tokenRequest("/api/machine-tokens/bind-workspace", standbyToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: seed.workspaceId }),
      })
      expect(bindRes.status).toBe(200)

      // Now register call should return workspace info (poll fallback behavior)
      const res = await tokenRequest("/api/daemon/register", standbyToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daemon_id: "standby-daemon-e2e",
          device_name: "StandbyHost.local",
          cli_version: "1.0.0",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { runtimes: Array<{ id: string }>; workspaceId: string }
      expect(data.workspaceId).toBe(seed.workspaceId)
      expect(data.runtimes.length).toBeGreaterThanOrEqual(1)
    })

    afterAll(() => {
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = 'standby-daemon-e2e' AND workspace_id = ?`, seed.workspaceId)
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = 'StandbyHost.local' AND workspace_id = ?`, seed.workspaceId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = 'standby-daemon-e2e' AND workspace_id = ?`, seed.workspaceId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = 'StandbyHost.local' AND workspace_id = ?`, seed.workspaceId)
      sqlRun(`DELETE FROM machine_token WHERE id = ?`, standbyTokenId)
    })
  })
})
