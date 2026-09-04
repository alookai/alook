import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getBotOwnedBy = vi.fn()
const listMarksForUser = vi.fn()
const getChannelsByIds = vi.fn()
const getServersByIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: { getBotOwnedBy: (...args: unknown[]) => getBotOwnedBy(...args) },
      communityMessageMark: {
        listMarksForUser: (...args: unknown[]) => listMarksForUser(...args),
      },
      communityChannel: {
        getChannelsByIds: (...args: unknown[]) => getChannelsByIds(...args),
      },
      communityServer: {
        getServersByIds: (...args: unknown[]) => getServersByIds(...args),
      },
    },
  }
})

let isAuthed = true
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    return handler(req, {
      env: { DB: {} },
      userId: "owner_1",
      params: await ctx?.params,
    })
  },
}))
vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown) => NextResponse.json(data),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

const request = () => new NextRequest("http://localhost/api/community/bots/bot_1/marks")
const context = () => ({ params: Promise.resolve({ id: "bot_1" }) }) as any

describe("GET /api/community/bots/[id]/marks", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    getBotOwnedBy.mockResolvedValue({ id: "bot_1", ownerUserId: "owner_1" })
    listMarksForUser.mockResolvedValue([])
    getChannelsByIds.mockResolvedValue([])
    getServersByIds.mockResolvedValue([])
  })

  it("returns 401 before reading bot ownership or marks", async () => {
    isAuthed = false
    const response = await GET(request(), context())

    expect(response.status).toBe(401)
    expect(getBotOwnedBy).not.toHaveBeenCalled()
    expect(listMarksForUser).not.toHaveBeenCalled()
  })

  it("returns owner-scoped 404 before reading another bot's marks", async () => {
    getBotOwnedBy.mockResolvedValue(null)
    const response = await GET(request(), context())

    expect(response.status).toBe(404)
    expect(getBotOwnedBy).toHaveBeenCalledWith(expect.anything(), "bot_1", "owner_1")
    expect(listMarksForUser).not.toHaveBeenCalled()
  })

  it("returns the bot's direct mark queue with a four-row preview limit", async () => {
    listMarksForUser.mockResolvedValue([
      {
        mark: { id: "mark_1", channelId: "channel_1" },
        message: {
          id: "message_1",
          content: "Ship the sticker",
          seq: 42,
          createdAt: "2026-09-04T00:00:00.000Z",
        },
        author: {
          id: "author_1",
          name: "Gus",
          image: null,
          avatarVersion: 0,
        },
      },
    ])
    getChannelsByIds.mockResolvedValue([
      { id: "channel_1", name: "ship-room", serverId: "server_1", parentChannelId: null },
    ])
    getServersByIds.mockResolvedValue([{ id: "server_1", name: "Alook" }])
    const response = await GET(request(), context())

    expect(response.status).toBe(200)
    expect(listMarksForUser).toHaveBeenCalledWith(expect.anything(), "bot_1", { limit: 4 })
    expect(getChannelsByIds).toHaveBeenCalledWith(expect.anything(), ["channel_1"])
    expect(getServersByIds).toHaveBeenCalledWith(expect.anything(), ["server_1"])
    await expect(response.json()).resolves.toEqual({
      marked: [{
        id: "mark_1",
        server: "Alook",
        serverId: "server_1",
        channel: "ship-room",
        channelId: "channel_1",
        parentChannelId: null,
        m: {
          id: "message_1",
          authorId: "author_1",
          authorName: "Gus",
          authorAvatar: "G",
          authorAvatarVersion: 0,
          content: "Ship the sticker",
          seq: 42,
          createdAt: "2026-09-04T00:00:00.000Z",
        },
      }],
    })
  })

  it("keeps a persisted mark after the bot loses channel access", async () => {
    listMarksForUser.mockResolvedValue([{
      mark: { id: "stale_mark", channelId: "former_channel" },
      message: {
        id: "stale_message",
        content: "Follow up after leaving",
        seq: 7,
        createdAt: "2026-09-03T00:00:00.000Z",
      },
      author: {
        id: "author_2",
        name: "Former teammate",
        image: null,
        avatarVersion: 0,
      },
    }])
    getChannelsByIds.mockResolvedValue([{
      id: "former_channel",
      name: "private-history",
      serverId: "former_server",
      parentChannelId: null,
    }])
    getServersByIds.mockResolvedValue([{ id: "former_server", name: "Past room" }])

    const response = await GET(request(), context())

    expect(response.status).toBe(200)
    expect(listMarksForUser).toHaveBeenCalledWith(expect.anything(), "bot_1", { limit: 4 })
    await expect(response.json()).resolves.toMatchObject({
      marked: [{
        id: "stale_mark",
        server: "Past room",
        channel: "private-history",
        m: { content: "Follow up after leaving" },
      }],
    })
  })
})
