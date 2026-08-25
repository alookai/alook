import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
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
        getAccountReadStateSnapshot: (...args: unknown[]) => mocks.snapshot(...args),
      },
    },
    withD1Retry: (operation: () => unknown) => operation(),
  }
})
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

import { GET } from "./route"

describe("GET /api/community/users/me/read-state", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the durable revision with the complete account read-state rows", async () => {
    const readStates = [{
      channelId: "c1",
      lastReadMessageId: "m7",
      lastReadAt: "2026-08-24T00:00:00.000Z",
      lastReadSeq: 7,
    }]
    mocks.snapshot.mockResolvedValue({ revision: 12, readStates })

    const response = await GET(new Request("http://localhost/api/community/users/me/read-state") as any)
    await expect(response.json()).resolves.toEqual({ revision: 12, readStates })
    expect(mocks.snapshot).toHaveBeenCalledWith({ kind: "primary-db" }, "u1")
    expect(mocks.getPrimaryDb).toHaveBeenCalledOnce()
  })

  it("returns revision zero and no rows for a fresh account", async () => {
    mocks.snapshot.mockResolvedValue({ revision: 0, readStates: [] })
    const response = await GET(new Request("http://localhost/api/community/users/me/read-state") as any)
    await expect(response.json()).resolves.toEqual({ revision: 0, readStates: [] })
  })
})
