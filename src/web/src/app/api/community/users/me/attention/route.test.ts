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
      communityAttention: {
        getAccountAttentionSnapshot: (...args: unknown[]) => mocks.snapshot(...args),
      },
    },
    readOrStale: (operation: () => unknown) => Promise.resolve(operation()).then((value) => ({
      value,
      stale: false,
    })),
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (request: any) => handler(request, {
    env: { DB: { binding: "d1" } },
    userId: "u1",
  }),
}))
vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown) => Response.json(data),
}))

import { GET } from "./route"

describe("GET /api/community/users/me/attention", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses the primary-authoritative session for the stateless snapshot", async () => {
    mocks.snapshot.mockResolvedValue({
      scopes: [],
      items: [],
      limit: 100,
      truncated: false,
      included: {
        servers: [], channels: [], dms: [], profiles: [], messages: [],
      },
    })

    const response = await GET(new Request("http://localhost/api/community/users/me/attention") as any)

    await expect(response.json()).resolves.toMatchObject({ scopes: [], items: [] })
    expect(mocks.getPrimaryDb).toHaveBeenCalledWith({ binding: "d1" })
    expect(mocks.snapshot).toHaveBeenCalledWith({ kind: "primary-db" }, "u1", 100)
  })
})
