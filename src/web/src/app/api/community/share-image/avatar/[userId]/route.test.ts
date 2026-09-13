import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const routeMocks = vi.hoisted(() => ({
  getPublicProfileForViewer: vi.fn(),
  getDb: vi.fn(() => ({ db: true })),
}))

vi.mock("@/lib/db", () => ({ getDb: routeMocks.getDb }))
vi.mock("@alook/shared", () => ({
  queries: {
    communityUserProfile: {
      getPublicProfileForViewer: (...args: unknown[]) => routeMocks.getPublicProfileForViewer(...args),
    },
  },
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: "database" }, userId: "viewer-1", params })
  }),
}))

import { GET, allowedExternalAvatarUrl } from "./route"

function request(userId = "u2", query = "") {
  return GET(
    new NextRequest(`http://localhost/api/community/share-image/avatar/${userId}${query}`),
    { params: { userId } } as never,
  )
}

function imageResponse(size = 3, headers: Record<string, string> = {}) {
  const bytes = new ArrayBuffer(size)
  new Uint8Array(bytes).set([1, 2, 3].slice(0, size))
  return new Response(bytes, {
    headers: { "Content-Type": "image/png", ...headers },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  routeMocks.getPublicProfileForViewer.mockResolvedValue({
    id: "u2",
    image: "https://avatars.githubusercontent.com/u/42?v=4&token=private",
  })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse()))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("allowedExternalAvatarUrl", () => {
  it.each([
    "http://avatars.githubusercontent.com/u/1",
    "https://user:pass@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com:444/u/1",
    "https://avatars.githubusercontent.com.evil.example/u/1",
    "https://127.0.0.1/avatar.png",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.2/avatar.png",
    "file:///etc/passwd",
    "not a url",
  ])("rejects unsafe avatar source %s", (source) => {
    expect(allowedExternalAvatarUrl(source)).toBeNull()
  })

  it.each([
    "https://avatars.githubusercontent.com/u/1",
    "https://lh3.googleusercontent.com/a/photo",
    "https://avatars.githubusercontent.com:443/u/1",
  ])("allows exact HTTPS identity hosts %s", (source) => {
    expect(allowedExternalAvatarUrl(source)?.href).toBe(new URL(source).href)
  })
})

describe("GET /api/community/share-image/avatar/[userId]", () => {
  it("loads only the viewer-visible profile source and never trusts a client URL", async () => {
    const response = await request("u2", "?url=http://169.254.169.254/latest/meta-data&token=leak")

    expect(response.status).toBe(200)
    expect(routeMocks.getDb).toHaveBeenCalledWith("database")
    expect(routeMocks.getPublicProfileForViewer).toHaveBeenCalledWith(
      expect.anything(),
      "u2",
      "viewer-1",
    )
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [target, init] = fetchMock.mock.calls[0]!
    expect(String(target)).toBe("https://avatars.githubusercontent.com/u/42?v=4&token=private")
    expect(init).toMatchObject({ redirect: "manual" })
    expect(init).not.toHaveProperty("credentials")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("cache-control")).toBe("private, max-age=300")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it.each([
    null,
    "http://avatars.githubusercontent.com/u/1",
    "https://127.0.0.1/avatar.png",
    "https://example.com/avatar.png",
  ])("rejects missing or non-allowlisted stored source %s without fetching", async (image) => {
    routeMocks.getPublicProfileForViewer.mockResolvedValue({ id: "u2", image })

    const response = await request()

    expect(response.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects upstream redirects before a private-network hop", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1/admin" },
    }))

    const response = await request()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "external avatar redirect rejected" })
  })

  it("rejects non-image responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not an image", {
      headers: { "Content-Type": "text/html" },
    }))

    const response = await request()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "external avatar unavailable" })
  })

  it("rejects an oversized response before reading its body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(imageResponse(0, {
      "Content-Length": String(5 * 1024 * 1024 + 1),
    }))

    const response = await request()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "external avatar unavailable" })
  })

  it("stops an oversized streamed response without a declared length", async () => {
    const chunk = new Uint8Array(3 * 1024 * 1024)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    }), { headers: { "Content-Type": "image/png" } }))

    const response = await request()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "external avatar unavailable" })
  })

  it("times out the upstream fetch at the fixed bound", async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockImplementationOnce((_target, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"))
      }, { once: true })
    }))
    const pending = request()

    await vi.advanceTimersByTimeAsync(5_000)
    const response = await pending

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ error: "external avatar timed out" })
  })

  it("does not log the stored URL when upstream fetching fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network failed"))

    const response = await request()

    expect(response.status).toBe(502)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
