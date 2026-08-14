import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const listChannelRefDirectoryForUser = vi.fn()
const db = { scoped: true }

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => db) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        listChannelRefDirectoryForUser: (...args: unknown[]) =>
          listChannelRefDirectoryForUser(...args),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any) =>
    handler(req, { env: { DB: {} }, userId: "viewer_1", email: "viewer@alook.test" }),
  ),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return { writeJSON: (data: unknown) => NextResponse.json(data) }
})

import { GET } from "./route"

describe("GET /api/community/users/me/channel-directory", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns the member-scoped directory without a per-server request loop", async () => {
    const directory = [
      {
        id: "server_1",
        name: "Studio",
        discriminator: "0042",
        channels: [{ id: "channel_1", name: "general" }],
      },
    ]
    listChannelRefDirectoryForUser.mockResolvedValue(directory)

    const response = await GET(
      new NextRequest("http://localhost/api/community/users/me/channel-directory"),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ directory })
    expect(listChannelRefDirectoryForUser).toHaveBeenCalledWith(db, "viewer_1")
    expect(listChannelRefDirectoryForUser).toHaveBeenCalledTimes(1)
  })
})
