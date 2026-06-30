import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockDismissEvents = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", () => ({
  createDb: vi.fn(() => ({})),
  queries: {
    communityInbox: {
      dismissEvents: (...args: unknown[]) => mockDismissEvents(...args),
    },
  },
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

function postBody(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/community/inbox/foryou/dismiss", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/community/inbox/foryou/dismiss", () => {
  beforeEach(() => vi.clearAllMocks())

  it("dismisses a single eventKey", async () => {
    mockDismissEvents.mockResolvedValue(undefined)
    const res = await POST(postBody({ eventKey: "mention:abc" }))
    expect(res.status).toBe(200)
    expect(mockDismissEvents).toHaveBeenCalledWith({}, "u1", ["mention:abc"])
  })

  it("dismisses multiple eventKeys", async () => {
    mockDismissEvents.mockResolvedValue(undefined)
    const res = await POST(postBody({ eventKeys: ["mention:a", "reply:b", "thread:c"] }))
    expect(res.status).toBe(200)
    expect(mockDismissEvents).toHaveBeenCalledWith({}, "u1", ["mention:a", "reply:b", "thread:c"])
  })

  it("400 when no keys provided", async () => {
    const res = await POST(postBody({}))
    expect(res.status).toBe(400)
    expect(mockDismissEvents).not.toHaveBeenCalled()
  })

  it("400 when an eventKey has an unknown prefix", async () => {
    const res = await POST(postBody({ eventKey: "foo:bar" }))
    expect(res.status).toBe(400)
    expect(mockDismissEvents).not.toHaveBeenCalled()
  })

  it("400 when body is not JSON", async () => {
    const res = await POST(new NextRequest("http://localhost/api/community/inbox/foryou/dismiss", {
      method: "POST",
      body: "not json",
    }))
    expect(res.status).toBe(400)
  })
})
