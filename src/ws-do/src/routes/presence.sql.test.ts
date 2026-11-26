import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "@alook/shared"
import { createMockCtx } from "../__mocks__/cf"
import { createCountingSqliteD1 } from "../test/sqlite-d1"
import { handleBatchPresence } from "./presence"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { WebSocketDurableObject } = await import("../ws-durable")

const openDbs: Array<{ close: () => void }> = []

afterEach(() => {
  for (const sqlite of openDbs) sqlite.close()
  openDbs.length = 0
})

describe("POST /presence/users bulk bot resolution", () => {
  it("resolves bots in one bulk D1 query with zero bot DO wakeups and zero D1 reads in /check-user-online", async () => {
    const db = createCountingSqliteD1(openDbs as never)
    const now = "2026-11-26T00:00:00.000Z"
    const insertUser = db.sqlite.prepare(
      'INSERT INTO user (id, email, name, discriminator, "isBot", "avatarVersion", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    )
    const insertBinding = db.sqlite.prepare(
      "INSERT INTO community_bot_binding (user_id, machine_id, runtime, is_active, created_at) VALUES (?, ?, 'codex', 1, ?)",
    )
    const ids: string[] = []
    db.sqlite.exec("BEGIN")
    db.sqlite.prepare(
      "INSERT INTO community_machine (id, user_id, display_name, hostname, platform, arch, os_release, daemon_version, available_runtimes, status, created_at, updated_at) VALUES ('m-on', 'human-0', 'Host', 'host', 'darwin', 'arm64', '1', '1', '[]', 'online', ?, ?)",
    ).run(now, now)
    db.sqlite.prepare(
      "INSERT INTO community_machine (id, user_id, display_name, hostname, platform, arch, os_release, daemon_version, available_runtimes, status, created_at, updated_at) VALUES ('m-off', 'human-0', 'Host2', 'host2', 'darwin', 'arm64', '1', '1', '[]', 'offline', ?, ?)",
    ).run(now, now)
    for (let i = 0; i < 300; i++) {
      const uid = `human-${i}`
      ids.push(uid)
      insertUser.run(uid, `${uid}@example.test`, `Human${i}`, String(i).padStart(4, "0"), 0, now, now)
    }
    for (let i = 0; i < 100; i++) {
      const uid = `bot-${i}`
      ids.push(uid)
      insertUser.run(uid, `${uid}@example.test`, `Bot${i}`, String(i).padStart(4, "0"), 1, now, now)
      insertBinding.run(uid, i < 40 ? "m-on" : "m-off", now)
    }
    db.sqlite.exec("COMMIT")

    let humanDoWakeups = 0
    let botDoWakeups = 0
    const env = {
      DB: db.d1,
      WS_DO: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn((name: string) => {
          if (name.startsWith("user:bot-")) botDoWakeups += 1
          else humanDoWakeups += 1
          const { ctx } = createMockCtx()
          const durable = new WebSocketDurableObject(ctx, { DB: db.d1 } as unknown as Env)
          return { fetch: (req: Request) => durable.fetch(req) }
        }),
      },
    } as unknown as Env

    db.resetCount()
    const presenceReq = new Request("http://internal/presence/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
    const response = await handleBatchPresence({
      request: presenceReq,
      env,
      url: new URL(presenceReq.url),
      traceId: "t-presence",
      log: createLogger({ service: "test" }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { online: string[]; offline: string[] }
    expect(body.online).toHaveLength(40)
    expect(body.offline).toHaveLength(360)
    expect(botDoWakeups).toBe(0)
    expect(humanDoWakeups).toBe(300)
    expect(db.queries.length).toBe(1)
  })
})
