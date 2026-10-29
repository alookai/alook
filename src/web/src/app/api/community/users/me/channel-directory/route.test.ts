import { channelResourceFixture, serverResourceFixture, fullResourceBundleFixture } from "@/test/community-resource-fixtures"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const listChannelRefDirectoryForUser = vi.fn()
const readResourceBundle = vi.fn()
vi.mock("@/lib/community/attention-resources.server", () => ({ readCommunityResourceBundle: (...args: unknown[]) => readResourceBundle(...args) }))
const db = { scoped: true }

vi.mock("@/lib/db", () => ({ getPrimaryDb: vi.fn(() => db) }))

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
    const resources = fullResourceBundleFixture("viewer_1", [serverResourceFixture({ id: "server_1", name: "Studio", discriminator: "0042", ownerId: "owner", isOwner: false })], [channelResourceFixture({ id: "channel_1", serverId: "server_1", name: "general" })])
    readResourceBundle.mockResolvedValue(resources)

    const response = await GET(
      new NextRequest("http://localhost/api/community/users/me/channel-directory"),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ directory, resources })
    expect(readResourceBundle).toHaveBeenCalledExactlyOnceWith(db, "viewer_1", { serverIds: ["server_1"], channelIds: ["channel_1"] })
    expect(listChannelRefDirectoryForUser).toHaveBeenCalledWith(db, "viewer_1")
    expect(listChannelRefDirectoryForUser).toHaveBeenCalledTimes(1)
  })
})
