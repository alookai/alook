/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const runtimeEnv = env as unknown as {
  DB: D1Database
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
