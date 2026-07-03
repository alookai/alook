import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannelForMember = vi.fn()
const mockGetChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateMentions = vi.fn()
const mockCreateAttachment = vi.fn()

const mockFanOutToChannel = vi.fn()
const mockBroadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
      },
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
      },
      communityMention: {
        createMentions: (...a: unknown[]) => mockCreateMentions(...a),
      },
      communityAttachment: {
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
}))

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
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
import { WS_EVENTS } from "@alook/shared"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/threads/t1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

const ctx = { params: { id: "t1" } } as any

describe("POST /api/community/threads/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({
      id: "t1",
      serverId: "s1",
      parentChannelId: "c-parent",
    })
    mockGetChannel.mockResolvedValue({
      id: "t1",
      serverId: "s1",
      parentChannelId: "c-parent",
      messageCount: 7,
      lastMessageAt: "2026-06-30T01:00:00.000Z",
    })
    mockCreateMessage.mockResolvedValue({ id: "m1" })
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      content: "in-thread",
      type: "default",
      createdAt: "2026-06-30T01:00:00.000Z",
    })
    mockListMembers.mockResolvedValue([])
    mockListMemberUserIds.mockResolvedValue([])
    mockFanOutToChannel.mockResolvedValue(undefined)
  })

  it("fans CHILD_CHANNEL_UPDATE to the parent channel after a thread reply", async () => {
    const res = await POST(postReq({ content: "in-thread" }), ctx)

    expect(res.status).toBe(201)

    const childUpdateCall = mockFanOutToChannel.mock.calls.find(
      (c) => c[1]?.type === WS_EVENTS.CHILD_CHANNEL_UPDATE,
    )
    expect(childUpdateCall).toBeTruthy()
    expect(childUpdateCall![0]).toBe("c-parent")
    expect(childUpdateCall![1].parentChannelId).toBe("c-parent")
    expect(childUpdateCall![1].channelId).toBe("t1")
    expect(childUpdateCall![1].changes.messageCount).toBe(7)
  })
})
