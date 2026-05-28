import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, sqlRun, sqlQuery } from "@alook/test-utils"

const testEmail = `e2e_ws_${randomUUID().slice(0, 8)}@test.local`
const testPassword = "TestPassword123!"
let cookie: string

beforeAll(async () => {
  await signUp(testEmail, testPassword, "WS User")
  cookie = await signIn(testEmail, testPassword)
})

afterAll(() => {
  try {
    sqlRun(`DELETE FROM member WHERE user_id IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
    sqlRun(`DELETE FROM workspace WHERE id IN (SELECT workspace_id FROM member WHERE user_id IN (SELECT id FROM "user" WHERE email = ?))`, testEmail)
    sqlRun(`DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
    sqlRun(`DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
    sqlRun(`DELETE FROM "user" WHERE email = ?`, testEmail)
  } catch { /* ignore */ }
})

describe("workspace", () => {
  const slug = `e2e-ws-${randomUUID().slice(0, 8)}`
  let workspaceId: string

  it("POST /api/workspaces creates a workspace", async () => {
    const res = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "E2E Workspace", slug }),
    })
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.name).toBe("E2E Workspace")
    expect(data.slug).toBe(slug)
    expect(data.id).toBeTruthy()
    workspaceId = data.id as string
  })

  it("POST /api/workspaces auto-suffixes duplicate slug", async () => {
    const res = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dup Workspace", slug }),
    })
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.name).toBe("Dup Workspace")
    // Slug should start with the original slug but have a suffix
    expect(data.slug).not.toBe(slug)
    expect((data.slug as string).startsWith(`${slug}-`)).toBe(true)
  })

  it("GET /api/workspaces lists user's workspaces", async () => {
    const res = await sessionRequest("/api/workspaces", cookie)
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(data.some(w => w.slug === slug)).toBe(true)
  })

  it("GET /api/workspaces/:id returns workspace", async () => {
    const res = await sessionRequest(`/api/workspaces/${workspaceId}`, cookie)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.id).toBe(workspaceId)
    expect(data.name).toBe("E2E Workspace")
  })

  it("POST /api/workspaces rejects missing name", async () => {
    const res = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "no-name" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("workspace isolation", () => {
  const slugA = `e2e-iso-a-${randomUUID().slice(0, 8)}`
  const slugB = `e2e-iso-b-${randomUUID().slice(0, 8)}`
  let workspaceIdA: string
  let workspaceIdB: string
  const daemonId = `daemon_iso_${randomUUID().slice(0, 8)}`

  it("creates two separate workspaces", async () => {
    // Create workspace A
    const resA = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace A", slug: slugA }),
    })
    expect(resA.status).toBe(201)
    const dataA = await resA.json() as Record<string, unknown>
    workspaceIdA = dataA.id as string

    // Create workspace B
    const resB = await sessionRequest("/api/workspaces", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Workspace B", slug: slugB }),
    })
    expect(resB.status).toBe(201)
    const dataB = await resB.json() as Record<string, unknown>
    workspaceIdB = dataB.id as string

    expect(workspaceIdA).not.toBe(workspaceIdB)
  })

  it("registering daemon to workspace A does not affect workspace B", async () => {
    // Create machine token for workspace A
    const tokenId = `mt_iso_${randomUUID().replace(/-/g, "").slice(0, 16)}`
    const rawToken = `al_${randomUUID().replace(/-/g, "")}`
    const now = new Date().toISOString()
    sqlRun(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, (SELECT id FROM "user" WHERE email = ?), ?, ?, ?, ?, ?)`, tokenId, testEmail, workspaceIdA, rawToken, 'iso-token', 'active', now)

    // Register daemon to workspace A
    const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
    const res = await fetch(`${APP_URL}/api/daemon/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${rawToken}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceIdA,
        daemon_id: daemonId,
        device_name: "iso-machine",
        cli_version: "0.1.0",
        runtimes: [{ provider: "claude", runtime_mode: "local", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { runtimes: Array<{ id: string }>; workspaceId: string }
    expect(data.workspaceId).toBe(workspaceIdA)
    expect(data.runtimes).toHaveLength(1)

    // Workspace A should have the runtime
    const runtimesA = sqlQuery<{ id: string }>(
      `SELECT id FROM agent_runtime WHERE workspace_id = ? AND daemon_id = ?`, workspaceIdA, daemonId
    )
    expect(runtimesA.length).toBeGreaterThan(0)

    // Workspace B should have NO runtimes
    const runtimesB = sqlQuery<{ id: string }>(
      `SELECT id FROM agent_runtime WHERE workspace_id = ? AND daemon_id = ?`, workspaceIdB, daemonId
    )
    expect(runtimesB).toHaveLength(0)

    // Workspace B should have NO machine entry for this daemon
    const machinesB = sqlQuery<{ daemon_id: string }>(
      `SELECT daemon_id FROM machine WHERE workspace_id = ? AND daemon_id = ?`, workspaceIdB, daemonId
    )
    expect(machinesB).toHaveLength(0)
  })

  afterAll(() => {
    try {
      sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = ?`, daemonId)
      sqlRun(`DELETE FROM machine WHERE daemon_id = ?`, daemonId)
      sqlRun(`DELETE FROM machine_token WHERE workspace_id IN (?, ?)`, workspaceIdA, workspaceIdB)
      sqlRun(`DELETE FROM member WHERE workspace_id IN (?, ?)`, workspaceIdA, workspaceIdB)
      sqlRun(`DELETE FROM workspace WHERE id IN (?, ?)`, workspaceIdA, workspaceIdB)
    } catch { /* ignore */ }
  })
})
