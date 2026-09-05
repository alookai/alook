import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const betterAuthGet = vi.fn()
const betterAuthPost = vi.fn()

vi.mock("@/lib/middleware/env", () => ({
  withEnv:
    (route: (request: NextRequest, context: { env: object }) => Promise<Response>) =>
    (request: NextRequest) => route(request, { env: {} }),
}))
vi.mock("@/lib/auth", () => ({ createAuth: () => ({}) }))
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({ GET: betterAuthGet, POST: betterAuthPost }),
}))

import { GET, POST } from "./route"

describe("Better Auth server-only endpoints", () => {
  beforeEach(() => {
    betterAuthGet.mockReset()
    betterAuthPost.mockReset()
  })

  it.each([
    ["GET", "/api/auth/one-time-token/generate"],
    ["POST", "/api/auth/one-time-token/verify"],
    ["POST", "/api/auth/one-time-token/verify/"],
  ])("blocks public %s %s before Better Auth", async (method, pathname) => {
    const request = new NextRequest(`https://alook.ai${pathname}`, { method })
    const response = method === "GET" ? await GET(request) : await POST(request)

    expect(response.status).toBe(404)
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(betterAuthGet).not.toHaveBeenCalled()
    expect(betterAuthPost).not.toHaveBeenCalled()
  })

  it("keeps ordinary Better Auth routes delegated", async () => {
    betterAuthPost.mockResolvedValue(new Response(null, { status: 204 }))
    const request = new NextRequest("https://alook.ai/api/auth/sign-in/email", {
      method: "POST",
    })

    const response = await POST(request)

    expect(response.status).toBe(204)
    expect(betterAuthPost).toHaveBeenCalledOnce()
  })
})
