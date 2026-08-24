import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  markAll: vi.fn(),
  broadcast: vi.fn(),
  getPrimaryDb: vi.fn(() => ({ kind: "primary-db" })),
}))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: (...args: unknown[]) => mocks.getPrimaryDb(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReadState: {
        ...actual.queries.communityReadState,
        markAllDmsRead: (...args: unknown[]) => mocks.markAll(...args),
      },
    },
  }
})
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mocks.broadcast(...args),
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: any) => handler(req, {
    env: { DB: {} },
    userId: "u1",
    email: "u@example.com",
  }),
}))
vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown) => Response.json(data),
}))

import { POST } from "./route"

describe("POST /api/community/users/me/inbox/dms/read-all", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.broadcast.mockResolvedValue(undefined)
  })

  it("broadcasts the committed revision to every same-account socket", async () => {
    const advances = [{
      channelId: "dm1",
      lastReadMessageId: "m8",
      lastReadAt: "2026-08-24T00:00:08.000Z",
      lastReadSeq: 8,
    }]
    mocks.markAll.mockResolvedValue({ count: 3, revision: 8, advances })
    const response = await POST(new Request("http://localhost", { method: "POST" }) as any)
    await expect(response.json()).resolves.toEqual({ ok: true, count: 3, revision: 8 })
    expect(mocks.broadcast).toHaveBeenCalledWith("u1", {
      type: "community:inbox.changed",
      revision: 8,
      advances,
      inboxChanged: true,
      reason: "read_all",
    })
    expect(mocks.markAll).toHaveBeenCalledWith({ kind: "primary-db" }, "u1")
  })

  it("does not broadcast an empty read-all no-op", async () => {
    mocks.markAll.mockResolvedValue({ count: 0, revision: null, advances: [] })
    const response = await POST(new Request("http://localhost", { method: "POST" }) as any)
    await expect(response.json()).resolves.toEqual({ ok: true, count: 0, revision: null })
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})
