import { describe, it, expect, beforeAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, sqlRun, sqlQuery } from "@alook/test-utils"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"

describe("token/workspace lifecycle — simplified activate flow", () => {
  const email = `e2e_token_${randomUUID().slice(0, 8)}@test.local`
  const password = "TestPass123!"
  let sessionCookie: string
  let workspaceId: string
  let firstToken: string

  beforeAll(async () => {
    await signUp(email, password, "E2E Token User")
    sessionCookie = await signIn(email, password)

    const wsRes = await sessionRequest("/api/workspaces", sessionCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TokenTest", slug: `e2e-tok-${randomUUID().slice(0, 8)}` }),
    })
    const ws = await wsRes.json() as { id: string }
    workspaceId = ws.id
  })

  describe("Token state transitions", () => {

    it("POST /machine-tokens creates a new token with status=pending", async () => {
      const res = await sessionRequest(
        `/api/machine-tokens?workspace_id=${workspaceId}`,
        sessionCookie,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
      )
      expect(res.status).toBe(201)
      const body = await res.json() as { token: string; status: string }
      expect(body.token).toMatch(/^al_/)
      expect(body.status).toBe("pending")
      firstToken = body.token
    })

    it("calling create again returns the same pending token", async () => {
      const res = await sessionRequest(
        `/api/machine-tokens?workspace_id=${workspaceId}`,
        sessionCookie,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
      )
      expect(res.status).toBe(200)
      const body = await res.json() as { token: string }
      expect(body.token).toBe(firstToken)
    })

    it("activate transitions to active and creates machine/runtime", async () => {
      const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: firstToken,
          hostname: "TestMachine.local",
          runtimes: [{ type: "claude", version: "4.0.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { daemon_id: string; workspace_id: string; runtimes: Array<{ id: string }> }
      expect(body.daemon_id).toBe("TestMachine.local")
      expect(body.workspace_id).toBe(workspaceId)
      expect(body.runtimes.length).toBeGreaterThan(0)
    })

    it("activate rejects already-active token", async () => {
      const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: firstToken,
          hostname: "TestMachine.local",
          runtimes: [{ type: "claude", version: "4.0.0" }],
        }),
      })
      expect(res.status).toBe(409)
    })

    it("activate rejects token without workspace_id", async () => {
      const tokenVal = `al_${randomUUID().replace(/-/g, "")}`
      sqlRun(
        `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, NULL, ?, 'cli', 'pending', datetime('now'))`,
        `mt_${randomUUID().slice(0, 21)}`, sqlQuery(`SELECT id FROM "user" WHERE email = ?`, email)[0]?.id, tokenVal,
      )
      const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenVal, hostname: "host", runtimes: [{ type: "claude" }] }),
      })
      expect(res.status).toBe(422)
    })
  })

  describe("Status API", () => {
    it("returns active status after activation", async () => {
      const res = await sessionRequest("/api/machine-tokens/status", sessionCookie)
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; hostname?: string; daemon_online?: boolean }
      expect(body.status).toBe("active")
      expect(body.hostname).toBe("TestMachine.local")
    })
  })
})
