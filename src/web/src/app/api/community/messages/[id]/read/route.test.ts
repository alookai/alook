import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getMessage: vi.fn(),
  getThread: vi.fn(),
  access: vi.fn(),
  needsSparse: vi.fn(),
  unreadMention: vi.fn(),
  advanceRevision: vi.fn(),
  markSparse: vi.fn(),
  markMention: vi.fn(),
  currentRevision: vi.fn(),
  batch: vi.fn(),
  broadcast: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: () => ({ batch: (...args: unknown[]) => mocks.batch(...args) }),
}))

vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => mocks.access(...args),
}))

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mocks.broadcast(...args),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessage: (...args: unknown[]) => mocks.getMessage(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        getThreadChannelByParentMessage: (...args: unknown[]) => mocks.getThread(...args),
      },
      communityForumOpenerRead: {
        ...actual.queries.communityForumOpenerRead,
        forumOpenerNeedsSparseReadCondition: (...args: unknown[]) => mocks.needsSparse(...args),
        markForumOpenerReadBuilder: (...args: unknown[]) => mocks.markSparse(...args),
      },
      communityMention: {
        ...actual.queries.communityMention,
        unreadMessageMentionCondition: (...args: unknown[]) => mocks.unreadMention(...args),
        markMessageMentionsReadBuilder: (...args: unknown[]) => mocks.markMention(...args),
      },
      communityReadState: {
        ...actual.queries.communityReadState,
        advanceReadStateRevisionWhenAnyBuilder: (...args: unknown[]) => mocks.advanceRevision(...args),
        accountReadStateRevisionBuilder: (...args: unknown[]) => mocks.currentRevision(...args),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: Request, ctx?: any) => handler(req, {
    env: { DB: {} },
    userId: "u1",
    email: "u@example.com",
    params: ctx?.params,
  }),
}))

vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown, status = 200) => Response.json(data, { status }),
  writeError: (error: string, status: number) => Response.json({ error }, { status }),
}))

import { PUT } from "./route"

function request() {
  return new Request("http://localhost/api/community/messages/opener-1/read", {
    method: "PUT",
  })
}

describe("PUT /api/community/messages/[id]/read", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMessage.mockResolvedValue({
      id: "opener-1",
      channelId: "forum-1",
      seq: 12,
      createdAt: "2026-08-24T00:00:00.000Z",
    })
    mocks.access.mockResolvedValue({
      ok: true,
      value: { surface: "channel", channel: { id: "forum-1", type: "forum" } },
    })
    mocks.getThread.mockResolvedValue({
      id: "thread-1",
      type: "thread",
      parentMessageId: "opener-1",
    })
    mocks.needsSparse.mockReturnValue({ condition: "needs-sparse" })
    mocks.unreadMention.mockReturnValue({ condition: "unread-mention" })
    mocks.advanceRevision.mockReturnValue({ statement: "revision" })
    mocks.markSparse.mockReturnValue({ statement: "sparse" })
    mocks.markMention.mockReturnValue({ statement: "mention" })
    mocks.currentRevision.mockReturnValue({ statement: "current-revision" })
    mocks.batch.mockResolvedValue([
      [{ revision: 5 }],
      [],
      [],
      [{ revision: 5 }],
    ])
    mocks.broadcast.mockResolvedValue(undefined)
  })

  it("commits the guarded sparse read, exact mention repair, and one revision in order", async () => {
    const response = await PUT(request(), { params: { id: "opener-1" } } as any)

    expect(mocks.advanceRevision).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      [{ condition: "needs-sparse" }, { condition: "unread-mention" }],
    )
    expect(mocks.markSparse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: "u1",
      openerMessageId: "opener-1",
      condition: { condition: "needs-sparse" },
    }))
    expect(mocks.markMention).toHaveBeenCalledWith(expect.anything(), "u1", "opener-1")
    expect(mocks.batch.mock.calls[0]?.[0]).toEqual([
      { statement: "revision" },
      { statement: "sparse" },
      { statement: "mention" },
      { statement: "current-revision" },
    ])
    expect(mocks.broadcast).toHaveBeenCalledWith("u1", expect.objectContaining({
      reason: "forum_opener_read",
      revision: 5,
    }))
    await expect(response.json()).resolves.toEqual({
      changed: true,
      openerMessageId: "opener-1",
      revision: 5,
    })
  })

  it("returns the current revision and emits no frame for a duplicate or baseline-covered no-op", async () => {
    mocks.batch.mockResolvedValue([[], [], [], [{ revision: 5 }]])
    const response = await PUT(request(), { params: { id: "opener-1" } } as any)
    await expect(response.json()).resolves.toEqual({
      changed: false,
      openerMessageId: "opener-1",
      revision: 5,
    })
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it("preserves 400/404/403 and rejects non-forum or structurally invalid targets", async () => {
    expect((await PUT(request(), { params: {} } as any)).status).toBe(400)

    mocks.getMessage.mockResolvedValueOnce(null)
    expect((await PUT(request(), { params: { id: "missing" } } as any)).status).toBe(404)

    mocks.access.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })
    expect((await PUT(request(), { params: { id: "opener-1" } } as any)).status).toBe(403)

    mocks.access.mockResolvedValueOnce({ ok: true, value: { surface: "dm", dm: {} } })
    expect((await PUT(request(), { params: { id: "opener-1" } } as any)).status).toBe(409)

    mocks.getThread.mockResolvedValueOnce(null)
    expect((await PUT(request(), { params: { id: "opener-1" } } as any)).status).toBe(409)
    expect(mocks.batch).not.toHaveBeenCalled()
  })
})
