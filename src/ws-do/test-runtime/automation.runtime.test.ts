/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const runtimeEnv = env as unknown as { RATE_LIMIT_DO: DurableObjectNamespace }
const worker = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } }).default
function check(stub: DurableObjectStub, max = 64, period = "hour") {
  return stub.fetch(new Request("https://worker.test/check-automation", { method: "POST", body: JSON.stringify({ max, period }) }))
}
function stub() { return runtimeEnv.RATE_LIMIT_DO.get(runtimeEnv.RATE_LIMIT_DO.idFromName(crypto.randomUUID())) }

describe("automation rolling limits in real workerd", () => {
  it("atomically admits only 64 concurrent day requests within an hour and persists across stubs", async () => {
    const id = runtimeEnv.RATE_LIMIT_DO.idFromName(crypto.randomUUID())
    const first = runtimeEnv.RATE_LIMIT_DO.get(id)
    const results = await Promise.all(Array.from({ length: 80 }, async () => (await check(first, 1536, "day")).json<{ allowed: boolean }>()))
    expect(results.filter((result) => result.allowed)).toHaveLength(64)
    expect(results.filter((result) => !result.allowed)).toHaveLength(16)
    const another = runtimeEnv.RATE_LIMIT_DO.get(id)
    expect(await (await check(another, 1536, "day")).json()).toMatchObject({ allowed: false, retryAfterSec: expect.any(Number) })
    await runInDurableObject(another, async (_instance, state) => {
      expect(await state.storage.get<number[]>("automation")).toHaveLength(64)
    })
  })
  it("retains history when lowering rates or switching periods", async () => {
    const target = stub()
    expect(await (await check(target, 64)).json()).toEqual({ allowed: true })
    expect(await (await check(target, 1, "day")).json()).toMatchObject({ allowed: false })
    expect(await (await check(target, 1, "hour")).json()).toMatchObject({ allowed: false })
    expect(await (await check(target, 2, "hour")).json()).toEqual({ allowed: true })
    await runInDurableObject(target, async (_instance, state) => {
      expect(await state.storage.get<number[]>("automation")).toHaveLength(2)
    })
  })
  it("retains admitted usage after the Durable Object is reset", async () => {
    const id = runtimeEnv.RATE_LIMIT_DO.idFromName(crypto.randomUUID())
    const original = runtimeEnv.RATE_LIMIT_DO.get(id)
    expect(await (await check(original, 1)).json()).toEqual({ allowed: true })
    await expect(runInDurableObject(original, (_instance, state) => {
      state.abort("automation restart probe")
    })).rejects.toThrow()
    const restarted = runtimeEnv.RATE_LIMIT_DO.get(id)
    expect(await (await check(restarted, 1)).json()).toMatchObject({ allowed: false })
  })
  it("prunes rolling 24h history and computes retry time for every active constraint", async () => {
    const target = stub()
    await runInDurableObject(target, async (_instance, state) => {
      const now = Date.now()
      await state.storage.put("automation", [now - 86_400_001, now - 3_600_000 + 120_000])
    })
    expect(await (await check(target, 1)).json()).toMatchObject({ allowed: false, retryAfterSec: expect.any(Number) })
    await runInDurableObject(target, async (_instance, state) => {
      await state.storage.put("automation", [Date.now() - 86_400_001])
    })
    expect(await (await check(target, 1, "day")).json()).toEqual({ allowed: true })
    await runInDurableObject(target, async (_instance, state) => {
      expect(await state.storage.get<number[]>("automation")).toHaveLength(1)
    })
  })
  it("isolates code and permission shards through the real router", async () => {
    const key = crypto.randomUUID()
    const call = async (name: string, code: string) => (await worker.fetch(new Request("https://worker.test/rate-limit/automation", {
      method: "POST", body: JSON.stringify({ name, key: code, max: 1, period: "day" }),
    }))).json()
    expect(await call("bot.create", key)).toEqual({ allowed: true })
    expect(await call("bot.create", key)).toMatchObject({ allowed: false })
    expect(await call("server.create", key)).toEqual({ allowed: true })
    expect(await call("bot.create", crypto.randomUUID())).toEqual({ allowed: true })
  })
  it("rejects invalid policy input without creating state", async () => {
    const target = stub()
    for (const [max, period] of [[65, "hour"], [1537, "day"], [1.5, "day"], [0, "hour"], [1, "week"]] as const) {
      expect((await check(target, max, period)).status).toBe(400)
    }
    expect((await target.fetch(new Request("https://worker.test/check-automation", { method: "POST", body: "null" }))).status).toBe(400)
    await runInDurableObject(target, async (_instance, state) => {
      expect(await state.storage.get("automation")).toBeUndefined()
    })
  })
})
