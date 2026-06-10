import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, tokenRequest, sessionRequest, signUp, signIn, sqlRun, sqlQuery, fetchWithRetry } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
  sqlRun(
    `UPDATE machine_token SET hostname = ?, runtimes_json = ? WHERE id = ?`,
    "SeedHost.local", '[{"type":"claude","version":"4.0"}]', seed.machineTokenId,
  )
})
afterAll(() => {
  sqlRun(`DELETE FROM machine_token WHERE user_id = ? AND id != ?`, seed.userId, seed.machineTokenId)
  cleanupTestData(seed)
})

function ensureSeedIsLatest() {
  sqlRun(`DELETE FROM machine_token WHERE user_id = ? AND id != ?`, seed.userId, seed.machineTokenId)
}

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const WS_DO_PORT = Number(process.env.NEXT_PUBLIC_WS_DO_PORT) || 8789
const WS_DO_HTTP = `http://localhost:${WS_DO_PORT}`
const WS_DO_WS = `ws://localhost:${WS_DO_PORT}`

async function wsReachable(): Promise<boolean> {
  try {
    const res = await fetch(WS_DO_HTTP, { method: "GET" })
    return res.status < 500
  } catch {
    return false
  }
}

function openWs(userId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_DO_WS}/?userId=${userId}`)
    const onError = () => reject(new Error("ws failed to open"))
    ws.addEventListener("open", () => {
      ws.removeEventListener("error", onError)
      resolve(ws)
    }, { once: true })
    ws.addEventListener("error", onError, { once: true })
  })
}

function waitForMessage<T = unknown>(
  ws: WebSocket,
  predicate: (msg: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler)
      reject(new Error(`waitForMessage timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const handler = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as T
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener("message", handler)
          resolve(msg)
        }
      } catch { /* ignore non-JSON */ }
    }
    ws.addEventListener("message", handler)
  })
}

describe("token/workspace lifecycle — simplified activate flow", () => {

  describe("Token state transitions", () => {

    describe("Case 1: create token with workspace_id → pending", () => {
      it("POST /machine-tokens creates a new token with status=pending", async () => {
        ensureSeedIsLatest()
        const res = await sessionRequest(
          `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
          seed.sessionCookie,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
        )
        expect(res.status).toBe(201)
        const body = await res.json() as { token: string; status: string }
        expect(body.token).toMatch(/^al_/)
        expect(body.status).toBe("pending")
      })
    })

    describe("Case 2: activate → pending → active (creates machine + runtime rows)", () => {
      let pendingToken: string

      beforeAll(async () => {
        ensureSeedIsLatest()
        const res = await sessionRequest(
          `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
          seed.sessionCookie,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
        )
        const body = await res.json() as { token: string }
        pendingToken = body.token
      })

      it("activate transitions to active and creates machine/runtime", async () => {
        const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: pendingToken,
            hostname: "TestMachine.local",
            runtimes: [{ type: "claude", version: "4.0.0" }],
          }),
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { daemon_id: string; workspace_id: string; runtimes: Array<{ id: string }> }
        expect(body.daemon_id).toBe("TestMachine.local")
        expect(body.workspace_id).toBe(seed.workspaceId)
        expect(body.runtimes.length).toBeGreaterThan(0)

        const row = sqlQuery(`SELECT status, hostname FROM machine_token WHERE token = ?`, pendingToken)
        expect(row[0]?.status).toBe("active")
        expect(row[0]?.hostname).toBe("TestMachine.local")
      })
    })

    describe("Case 3: activate rejects non-pending token", () => {
      it("returns 409 for already-active token", async () => {
        const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: seed.machineToken,
            hostname: "TestMachine.local",
            runtimes: [{ type: "claude", version: "4.0.0" }],
          }),
        })
        expect(res.status).toBe(409)
      })
    })

    describe("Case 4: existing pending token → create endpoint reuses it", () => {
      let firstToken: string

      beforeAll(async () => {
        ensureSeedIsLatest()
        const res = await sessionRequest(
          `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
          seed.sessionCookie,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
        )
        const body = await res.json() as { token: string }
        firstToken = body.token
      })

      it("returns the existing pending token", async () => {
        const res = await sessionRequest(
          `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
          seed.sessionCookie,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
        )
        expect(res.status).toBe(200)
        const body = await res.json() as { token: string }
        expect(body.token).toBe(firstToken)
      })
    })

    describe("Case 5: activate token without workspace_id → 422", () => {
      it("returns 422 when token has no workspace", async () => {
        ensureSeedIsLatest()
        const tokenVal = `al_${randomUUID().replace(/-/g, "")}`
        sqlRun(
          `INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, NULL, ?, 'cli', 'pending', datetime('now'))`,
          `mt_${randomUUID().slice(0, 21)}`, seed.userId, tokenVal,
        )
        const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenVal, hostname: "host", runtimes: [{ type: "claude" }] }),
        })
        expect(res.status).toBe(422)
      })
    })
  })

  describe("Status API", () => {
    it("returns status and runtimes for active token", async () => {
      const res = await sessionRequest("/api/machine-tokens/status", seed.sessionCookie)
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; hostname?: string; runtimes?: unknown[] }
      expect(body.status).toBe("active")
      expect(body.hostname).toBe("SeedHost.local")
      expect(body.runtimes).toBeDefined()
    })
  })

  describe("Daemon WS auth", () => {
    it("broadcasts runtime.registered to user WS on activate", async () => {
      const reachable = await wsReachable()
      if (!reachable) return

      ensureSeedIsLatest()
      const tokenRes = await sessionRequest(
        `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
        seed.sessionCookie,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
      )
      const { token } = await tokenRes.json() as { token: string }

      const ws = await openWs(seed.userId)
      ws.send(JSON.stringify({ type: "auth", token: seed.sessionCookie.split("=").pop() }))

      const messagePromise = waitForMessage<{ type: string; workspaceId?: string }>(
        ws,
        (msg) => msg.type === "runtime.registered",
        10000,
      )

      await fetch(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, hostname: "WsTest.local", runtimes: [{ type: "claude", version: "4.0" }] }),
      })

      const msg = await messagePromise
      expect(msg.type).toBe("runtime.registered")
      expect(msg.workspaceId).toBe(seed.workspaceId)

      ws.close()
    })
  })
})
