import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

const mockWarn = vi.fn()
const mockCtxWaitUntil = vi.fn()
const mockGetCloudflareContext = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...(a as [])),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }
})

import { wsDoFetch, broadcastToUser } from "./broadcast"

const originalFetch = globalThis.fetch
const mockFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

function makeEnv(bindingFetch: (...args: unknown[]) => Promise<Response>): Env {
  return {
    WS_DO_WORKER: { fetch: bindingFetch },
    DEV_WS_DO_URL: "http://dev-ws:8789",
  } as unknown as Env
}

describe("wsDoFetch", () => {
  it("returns the binding response when it is OK (no fallback)", async () => {
    const bindingFetch = vi.fn(async () =>
      new Response("ok", { status: 200 }),
    )
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it("falls through to HTTP when the binding throws", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding missing")
    })
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://dev-ws:8789/x")
  })

  it("falls through to HTTP when the binding returns non-OK (5xx)", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://dev-ws:8789/x")
  })

  it("emits the observability warn line with label/type/path/status on binding non-OK", async () => {
    const bindingFetch = vi.fn(async () => new Response("bad", { status: 503 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    await wsDoFetch(env, "/presence/users", { method: "POST" }, { label: "srv_1", type: "presence" })
    expect(mockWarn).toHaveBeenCalledTimes(1)
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding non-ok",
      expect.objectContaining({
        label: "srv_1",
        type: "presence",
        path: "/presence/users",
        status: 503,
      }),
    )
  })

  it("does not log the observability warn when the binding is OK", async () => {
    const bindingFetch = vi.fn(async () => new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(mockWarn).not.toHaveBeenCalled()
  })
})

describe("broadcastToUser", () => {
  it("routes through wsDoFetch and falls back to HTTP on binding 502 (message not silently dropped)", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ sent: 1 }), { status: 200 }))
    const env = makeEnv(bindingFetch)
    mockGetCloudflareContext.mockReturnValue({
      env,
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    await broadcastToUser("u1", { type: "message:new" } as any)

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // The observability line must fire with the label (userId) + type + status.
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding non-ok",
      expect.objectContaining({
        label: "u1",
        type: "message:new",
        path: "/broadcast/user/u1",
        status: 502,
      }),
    )
  })

  it("does not throw when the binding returns OK", async () => {
    const bindingFetch = vi.fn(async () =>
      new Response(JSON.stringify({ sent: 1 }), { status: 200 }),
    )
    const env = makeEnv(bindingFetch)
    mockGetCloudflareContext.mockReturnValue({
      env,
      ctx: { waitUntil: mockCtxWaitUntil },
    })

    await expect(broadcastToUser("u1", { type: "message:new" } as any)).resolves.toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWarn).not.toHaveBeenCalled()
  })
})
