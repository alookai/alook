import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMessage = vi.fn()
const mockGetThread = vi.fn()
const mockReplaceTags = vi.fn()
const mockListTags = vi.fn()
const mockRequireChannelAccess = vi.fn()
const mockFanOutToChannel = vi.fn()

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
        replaceMessageTags: (...args: unknown[]) => mockReplaceTags(...args),
        listTagsForMessage: (...args: unknown[]) => mockListTags(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({
  requireChannelAccess: (...args: unknown[]) => mockRequireChannelAccess(...args),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...args: unknown[]) => mockFanOutToChannel(...args),
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
    mockListTags.mockResolvedValue([])
    mockFanOutToChannel.mockResolvedValue(undefined)
  })

  it("lets the opener author replace the normalized tag set", async () => {
    const res = await PUT(request([" Keep ", "NEW", "new"]), ctx)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ["keep", "new"] })
    expect(mockReplaceTags).toHaveBeenCalledWith(expect.anything(), { messageId: "m1", tags: ["keep", "new"] })
  })

  it("lets a server admin edit another author's opener tags", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "forum1", authorId: "u2" })
    mockRequireChannelAccess.mockResolvedValue({
      ok: true,
      value: { channel: { id: "forum1", type: "forum" }, member: { role: "admin" } },
    })

    const res = await PUT(request(["triage"]), ctx)
    expect(res.status).toBe(200)
    expect(mockReplaceTags).toHaveBeenCalledWith(expect.anything(), { messageId: "m1", tags: ["triage"] })
  })

  it("rejects a non-author member", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "forum1", authorId: "u2" })

    const res = await PUT(request(["nope"]), ctx)
    expect(res.status).toBe(403)
    expect(mockReplaceTags).not.toHaveBeenCalled()
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

  it("accepts Archived in addition to five ordinary tags", async () => {
    const tags = ["a", "b", "c", "d", "e", "archived"]
    const res = await PUT(request(tags), ctx)

    expect(res.status).toBe(200)
    expect(mockReplaceTags).toHaveBeenCalledWith(expect.anything(), { messageId: "m1", tags })
    expect(mockFanOutToChannel).toHaveBeenCalledWith("forum1", {
      type: "community:channel.child_update",
      parentChannelId: "forum1",
      channelId: "thread1",
      changes: { tags },
    })
  })

  it("does not write or fan out when the normalized set is unchanged", async () => {
    mockListTags.mockResolvedValue(["new", "keep"])

    const res = await PUT(request([" Keep ", "NEW"]), ctx)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: ["keep", "new"] })
    expect(mockReplaceTags).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })
})
