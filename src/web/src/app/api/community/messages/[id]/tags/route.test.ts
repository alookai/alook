import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMessage = vi.fn()
const mockGetThread = vi.fn()
const mockListTags = vi.fn()
const mockAddTag = vi.fn()
const mockRemoveTag = vi.fn()
const mockRequireChannelAccess = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: { ...actual.queries.communityMessage, getMessage: (...args: unknown[]) => mockGetMessage(...args) },
      communityChannel: { ...actual.queries.communityChannel, getThreadChannelByParentMessage: (...args: unknown[]) => mockGetThread(...args) },
      communityMessageTag: {
        ...actual.queries.communityMessageTag,
        listTagsForMessage: (...args: unknown[]) => mockListTags(...args),
        addMessageTag: (...args: unknown[]) => mockAddTag(...args),
        removeMessageTag: (...args: unknown[]) => mockRemoveTag(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({
  requireChannelAccess: (...args: unknown[]) => mockRequireChannelAccess(...args),
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: any, routeCtx: any) => handler(req, {
    env: { DB: {} },
    userId: "u1",
    params: routeCtx.params,
  }),
}))
vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (error: string, status: number) => NextResponse.json({ error }, { status }),
  }
})

import { PUT } from "./route"

function request(tags: unknown) {
  return new NextRequest("http://localhost/api/community/messages/m1/tags", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tags }),
  })
}

const ctx = { params: { id: "m1" } } as any

describe("PUT /api/community/messages/[id]/tags", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "forum1", authorId: "u1" })
    mockRequireChannelAccess.mockResolvedValue({
      ok: true,
      value: { channel: { id: "forum1", type: "forum" }, member: { role: "member" } },
    })
    mockGetThread.mockResolvedValue({ id: "thread1", type: "thread", parentMessageId: "m1" })
    mockListTags.mockResolvedValue(["old", "keep"])
  })

  it("lets the opener author replace the normalized tag set", async () => {
    const res = await PUT(request([" Keep ", "NEW", "new"]), ctx)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ["keep", "new"] })
    expect(mockRemoveTag).toHaveBeenCalledWith(expect.anything(), { messageId: "m1", tag: "old" })
    expect(mockAddTag).toHaveBeenCalledWith(expect.anything(), { messageId: "m1", tag: "new" })
  })

  it("lets a server admin edit another author's opener tags", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "forum1", authorId: "u2" })
    mockRequireChannelAccess.mockResolvedValue({
      ok: true,
      value: { channel: { id: "forum1", type: "forum" }, member: { role: "admin" } },
    })

    const res = await PUT(request(["triage"]), ctx)
    expect(res.status).toBe(200)
    expect(mockAddTag).toHaveBeenCalledWith(expect.anything(), { messageId: "m1", tag: "triage" })
  })

  it("rejects a non-author member", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "forum1", authorId: "u2" })

    const res = await PUT(request(["nope"]), ctx)
    expect(res.status).toBe(403)
    expect(mockListTags).not.toHaveBeenCalled()
  })

  it("rejects a normal forum message that did not open a thread", async () => {
    mockGetThread.mockResolvedValue(null)

    const res = await PUT(request(["nope"]), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "message is not a forum opener" })
  })

  it("enforces the server-side tag count limit", async () => {
    const res = await PUT(request(["a", "b", "c", "d", "e", "f"]), ctx)
    expect(res.status).toBe(400)
    expect(mockGetMessage).not.toHaveBeenCalled()
  })
})
