/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const runtimeEnv = env as unknown as {
  DB: D1Database
  RATE_LIMIT_DO: DurableObjectNamespace
  WS_DO: DurableObjectNamespace
}

const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> }
}).default

describe("ws-do workerd runtime", () => {
  it("loads production migrations and serves the production entrypoint", async () => {
    const schema = await runtimeEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind("community_machine").first<{ name: string }>()
    expect(schema?.name).toBe("community_machine")

    const response = await worker.fetch(new Request("https://worker.test/health"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ok" })
  })

  it("uses a real Durable Object for strongly consistent rate limits", async () => {
    const key = crypto.randomUUID()
    const check = () => worker.fetch(new Request("https://worker.test/rate-limit/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "runtime-test", key, windowMs: 60_000, max: 2 }),
    }))

    await expect((await check()).json()).resolves.toEqual({ allowed: true })
    await expect((await check()).json()).resolves.toEqual({ allowed: true })
    await expect((await check()).json()).resolves.toMatchObject({ allowed: false })
  })

  it("persists the counter across stubs for the same Durable Object id", async () => {
    const id = runtimeEnv.RATE_LIMIT_DO.idFromName(`runtime-${crypto.randomUUID()}`)
    const request = () => new Request("https://worker.test/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMs: 60_000, max: 1 }),
    })

    const first = await runtimeEnv.RATE_LIMIT_DO.get(id).fetch(request())
    await expect(first.json()).resolves.toEqual({ allowed: true })

    const second = await runtimeEnv.RATE_LIMIT_DO.get(id).fetch(request())
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({
      allowed: false,
      retryAfterSec: expect.any(Number),
    })
  })

  it("resets expired storage and rejects invalid Durable Object requests", async () => {
    const id = runtimeEnv.RATE_LIMIT_DO.idFromName(`runtime-${crypto.randomUUID()}`)
    const stub = runtimeEnv.RATE_LIMIT_DO.get(id)
    const check = () => stub.fetch(new Request("https://worker.test/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMs: 60_000, max: 1 }),
    }))

    await expect((await check()).json()).resolves.toEqual({ allowed: true })
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("state", { count: 1, windowStart: Date.now() - 60_001 })
    })
    await expect((await check()).json()).resolves.toEqual({ allowed: true })

    const invalid = await stub.fetch(new Request("https://worker.test/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowMs: 0, max: -1 }),
    }))
    expect(invalid.status).toBe(400)

    const malformed = await stub.fetch(new Request("https://worker.test/check", {
      method: "POST",
      body: "not json",
    }))
    expect(malformed.status).toBe(400)

    const missing = await stub.fetch(new Request("https://worker.test/missing", {
      method: "POST",
    }))
    expect(missing.status).toBe(404)
  })

  it("upgrades through the real WebSocket Durable Object", async () => {
    const id = runtimeEnv.WS_DO.idFromName(`runtime-${crypto.randomUUID()}`)
    const response = await runtimeEnv.WS_DO.get(id).fetch(new Request(
      "https://worker.test/?userId=runtime-user",
      { headers: { Upgrade: "websocket" } },
    ))

    expect(response.status).toBe(101)
    expect(response.webSocket).not.toBeNull()
    response.webSocket?.accept()
    response.webSocket?.close(1000, "runtime test complete")
  })
})
