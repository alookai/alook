/// <reference types="@cloudflare/vitest-plugin/types" />

import { runInDurableObject } from "cloudflare:test"
import { env, exports } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

const runtimeEnv = env as unknown as CloudflareEnv
const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> }
}).default

describe("Web workerd runtime", () => {
  it("loads production migrations and local storage bindings", async () => {
    const schema = await runtimeEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).bind("community_machine").first<{ name: string }>()
    expect(schema?.name).toBe("community_machine")

    const r2Key = `runtime/${crypto.randomUUID()}`
    await runtimeEnv.COMMUNITY_MEDIA.put(r2Key, "runtime media")
    await expect((await runtimeEnv.COMMUNITY_MEDIA.get(r2Key))!.text()).resolves.toBe("runtime media")
    await runtimeEnv.COMMUNITY_MEDIA.delete(r2Key)

    const kvKey = `runtime:${crypto.randomUUID()}`
    await runtimeEnv.CACHE_KV.put(kvKey, "runtime cache")
    await expect(runtimeEnv.CACHE_KV.get(kvKey)).resolves.toBe("runtime cache")
    await runtimeEnv.CACHE_KV.delete(kvKey)
  })

  it("uses the test-only OpenNext entry while preserving production cache behavior", async () => {
    const publicResponse = await worker.fetch(new Request("https://worker.test/pricing"))
    expect(await publicResponse.text()).toBe("open-next:/pricing")
    expect(publicResponse.headers.get("x-open-next")).toBe("test-entry")
    expect(publicResponse.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate")
    expect(publicResponse.headers.get("CDN-Cache-Control")).toBe(
      "public, s-maxage=3600, stale-while-revalidate=86400",
    )

    const privateResponse = await worker.fetch(new Request("https://worker.test/api/private"))
    expect(await privateResponse.text()).toBe("open-next:/api/private")
    expect(privateResponse.headers.get("Cache-Control")).toBeNull()
    expect(privateResponse.headers.get("CDN-Cache-Control")).toBeNull()
  })

  it("forwards WebSocket routes through the configured service binding", async () => {
    const response = await worker.fetch(new Request("https://worker.test/api/ws/runtime", {
      headers: { Upgrade: "websocket" },
    }))

    expect(response.status).toBe(101)
    expect(response.headers.get("x-runtime-pathname")).toBe("/api/ws/runtime")
    expect(response.headers.get("x-runtime-upgrade")).toBe("websocket")
    expect(response.webSocket).not.toBeNull()
    response.webSocket?.accept()
    response.webSocket?.close(1000, "runtime test complete")
  })

  it("exposes the production asset and Durable Object bindings locally", async () => {
    const asset = await runtimeEnv.ASSETS.fetch(new Request("https://assets.test/fixture.txt"))
    expect(asset.status).toBe(200)
    expect((await asset.text()).trim()).toBe("workerd asset fixture")

    const id = runtimeEnv.NEXT_CACHE_DO_QUEUE.idFromName(`runtime-${crypto.randomUUID()}`)
    const stub = runtimeEnv.NEXT_CACHE_DO_QUEUE.get(id)
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("runtime", "durable")
      await expect(state.storage.get("runtime")).resolves.toBe("durable")
    })
  })
})
