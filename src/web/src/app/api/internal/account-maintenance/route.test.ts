import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  maintain: vi.fn(),
}))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: mocks.context }))
vi.mock("@/lib/account-maintenance", () => ({ maintainAccounts: mocks.maintain }))
import { POST } from "./route"

beforeEach(() => vi.resetAllMocks())

it("rejects requests without the internal marker before accessing bindings", async () => {
  for (const marker of [undefined, "0"]) {
    const headers = marker ? { "X-Alook-Internal": marker } : undefined
    expect((await POST(new Request("https://example.test/api/internal/account-maintenance", { method: "POST", headers }))).status).toBe(404)
  }
  expect(mocks.context).not.toHaveBeenCalled()
  expect(mocks.maintain).not.toHaveBeenCalled()
})

it("awaits maintenance with the worker bindings and execution context", async () => {
  const env = { DB: {} }
  const ctx = { waitUntil: vi.fn() }
  mocks.context.mockResolvedValue({ env, ctx })
  const response = await POST(new Request("https://example.test/api/internal/account-maintenance", { method: "POST", headers: { "X-Alook-Internal": "1" } }))
  expect(mocks.context).toHaveBeenCalledWith({ async: true })
  expect(mocks.maintain).toHaveBeenCalledWith(env, ctx)
  expect(await response.json()).toEqual({ ok: true })
})

it("does not return success when maintenance fails", async () => {
  mocks.context.mockResolvedValue({ env: {}, ctx: {} })
  mocks.maintain.mockRejectedValue(new Error("maintenance unavailable"))
  await expect(POST(new Request("https://example.test/api/internal/account-maintenance", { method: "POST", headers: { "X-Alook-Internal": "1" } }))).rejects.toThrow("maintenance unavailable")
})
