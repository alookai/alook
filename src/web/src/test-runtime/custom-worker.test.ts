import handler, { DOQueueHandler } from "../../custom-worker"
import { describe, expect, it, vi } from "vitest"

describe("custom Worker composition", () => {
  it("composes the generated OpenNext module with the production runtime seam", async () => {
    const wsFetch = vi.fn(async () => new Response("ws"))
    const env = { WS_DO_WORKER: { fetch: wsFetch } } as unknown as CloudflareEnv

    const response = await handler.fetch!(
      new Request("https://worker.test/pricing"),
      env,
      {} as ExecutionContext,
    )

    expect(DOQueueHandler).toBeDefined()
    expect(await response.text()).toBe("node-open-next")
    expect(response.headers.get("x-open-next")).toBe("node-stub")
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate")
    expect(wsFetch).not.toHaveBeenCalled()
  })
})
