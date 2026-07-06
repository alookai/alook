import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

const mockInfo = vi.fn()
const mockWarn = vi.fn()
const mockError = vi.fn()
const mockDebug = vi.fn()
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
      info: (...a: unknown[]) => mockInfo(...a),
      warn: (...a: unknown[]) => mockWarn(...a),
      error: (...a: unknown[]) => mockError(...a),
      debug: (...a: unknown[]) => mockDebug(...a),
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

function makeEnvNoBinding(): Env {
  return {
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
    expect(mockInfo).not.toHaveBeenCalled()
    expect(mockError).not.toHaveBeenCalled()
  })

  it("returns the binding response on 4xx WITHOUT calling the HTTP fallback (client-error)", async () => {
    const bindingFetch = vi.fn(async () => new Response("nope", { status: 404 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(404)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledTimes(1)
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding non-ok (client-error)",
      expect.objectContaining({
        label: "L",
        type: "T",
        path: "/x",
        status: 404,
      }),
    )
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
    expect(mockWarn).toHaveBeenCalledWith(
      "broadcast service-binding threw, falling back",
      expect.objectContaining({ path: "/x", err: expect.stringContaining("binding missing") }),
    )
  })

  it("falls through to HTTP when the binding returns 5xx and logs 'recovered' when fallback succeeds", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(200)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://dev-ws:8789/x")
    expect(mockInfo).toHaveBeenCalledWith(
      "broadcast HTTP fallback recovered",
      expect.objectContaining({ label: "L", type: "T", path: "/x" }),
    )
  })

  it("emits the observability warn line with label/type/path/status on binding non-OK (5xx)", async () => {
    const bindingFetch = vi.fn(async () => new Response("bad", { status: 503 }))
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnv(bindingFetch)
    await wsDoFetch(env, "/presence/users", { method: "POST" }, { label: "srv_1", type: "presence" })
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

  it("logs error and rethrows when binding throws AND HTTP fallback throws", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding missing")
    })
    mockFetch.mockRejectedValue(new Error("network down"))
    const env = makeEnv(bindingFetch)
    await expect(
      wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" }),
    ).rejects.toThrow("network down")
    expect(mockError).toHaveBeenCalledWith(
      "broadcast HTTP fallback threw",
      expect.objectContaining({
        label: "L",
        type: "T",
        path: "/x",
        url: "http://dev-ws:8789",
        err: expect.stringContaining("network down"),
      }),
    )
  })

  it("logs error when binding is 5xx and HTTP fallback returns non-OK", async () => {
    const bindingFetch = vi.fn(async () => new Response("boom", { status: 502 }))
    mockFetch.mockResolvedValue(new Response("still bad", { status: 500 }))
    const env = makeEnv(bindingFetch)
    const res = await wsDoFetch(env, "/x", { method: "POST" }, { label: "L", type: "T" })
    expect(res.status).toBe(500)
    expect(mockError).toHaveBeenCalledWith(
      "broadcast HTTP fallback non-ok",
      expect.objectContaining({
        label: "L",
        type: "T",
        path: "/x",
        status: 500,
        url: "http://dev-ws:8789",
      }),
    )
  })

  it("skips the binding attempt entirely when WS_DO_WORKER is absent and returns fallback OK", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }))
    const env = makeEnvNoBinding()
    const res = await wsDoFetch(env, "/x", { method: "POST" })
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockWarn).not.toHaveBeenCalled()
    // No binding attempt → no "recovered" info line either.
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it("logs error and rethrows when no binding and HTTP fallback throws", async () => {
    mockFetch.mockRejectedValue(new Error("dns fail"))
    const env = makeEnvNoBinding()
    await expect(wsDoFetch(env, "/x", { method: "POST" })).rejects.toThrow("dns fail")
    expect(mockError).toHaveBeenCalledWith(
      "broadcast HTTP fallback threw",
      expect.objectContaining({ path: "/x", err: expect.stringContaining("dns fail") }),
    )
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
