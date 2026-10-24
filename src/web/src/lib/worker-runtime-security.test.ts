import { expect, it, vi } from "vitest"
import { createWebWorkerHandler } from "./worker-runtime"

it("strips forged internal authorization before any public request reaches OpenNext", async () => {
  const upstream = vi.fn(async (request: Request) => {
    expect(request.headers.has("X-Alook-Internal")).toBe(false)
    return new Response(null, { status: 404 })
  })
  const worker = createWebWorkerHandler({ fetch: upstream })
  for (const path of ["/api/internal/account-maintenance", "/api/internal//account-maintenance", "/api/internal/account-maintenance/"]) {
    const response = await worker.fetch!(new Request(`https://app.test${path}`, {
      method: "POST", headers: { "x-alook-internal": "1" },
    }), {} as CloudflareEnv, {} as ExecutionContext)
    expect(response.status).toBe(404)
  }
  expect(upstream).toHaveBeenCalledTimes(3)
})
