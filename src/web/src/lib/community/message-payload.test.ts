import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { beforeEach, describe, it, expect, vi } from "vitest"
const creationMocks = vi.hoisted(() => ({ hydrate: vi.fn(), attachments: vi.fn(), reactions: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries, communityBotCreation: { hydrateCreationRequestsForDmMessages: creationMocks.hydrate }, communityAttachment: { listByMessageIds: creationMocks.attachments }, communityReaction: { listReactionsByMessageIds: creationMocks.reactions } } }
})
import { botCreationFixture } from "@/test/bot-creation-fixtures"
import { readCommunityMessageResource, mapMessageForApi, mapMessageForWs, type MessageRow } from "./message-payload"

const baseRow: MessageRow = {
  id: "m1",
  authorId: "u_alice",
  authorAvatarVersion: 0,
  authorName: "Alice",
  authorImage: "https://avatars/alice.png",
  content: "hello",
  type: null,
  mentionType: null,
  replyToId: null,
  embeds: null,
  seq: 42,
  createdAt: "2026-07-03T12:00:00.000Z",
}

const emptyApiCtx = { viewerId: "u_alice",
  replyMap: new Map(),
  attachmentsByMessage: {},
  reactionsByMessage: {},
}

const emptyWsCtx = { replyMap: new Map(), resourceAttachments: [] }

describe("mapMessageForApi", () => {
  it("returns the core author/content/timestamp fields with avatar fallback", () => {
    const out = mapMessageForApi(baseRow, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.id).toBe("m1")
    expect(out.authorName).toBe("Alice")
    expect(out.authorAvatar).toBe("https://avatars/alice.png")
    expect(out.content).toBe("hello")
    expect(out.createdAt).toBe("2026-07-03T12:00:00.000Z")
  })

  it("coerces null content to empty string (message with attachments only)", () => {
    const out = mapMessageForApi({ ...baseRow, content: null }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.content).toBe("")
  })

  it("keeps a null stored avatar as null in the full resource", () => {
    const out = mapMessageForApi({ ...baseRow, authorImage: null, authorName: "Alice" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.authorAvatar).toBeNull()
  })

  it("maps ordinary rows to type: \"chat\" (never undefined — #12's exhaustive discriminator) and surfaces `system` verbatim", () => {
    expect(mapMessageForApi({ ...baseRow, type: null }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel").type).toBe("chat")
    expect(mapMessageForApi({ ...baseRow, type: "default" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel").type).toBe("chat")
    expect(mapMessageForApi({ ...baseRow, type: "system" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel").type).toBe("system")
  })

  it("splits `type: \"thread_created\"` into { type: \"system\", systemKind: \"thread\" }", () => {
    const out = mapMessageForApi({ ...baseRow, type: "thread_created" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.type).toBe("system")
    expect(out.systemKind).toBe("thread")
  })

  it("a bare `type: \"system\"` row (no known kind) omits systemKind", () => {
    const out = mapMessageForApi({ ...baseRow, type: "system" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.systemKind).toBeUndefined()
  })

  it("resolves replyTo from an in-scope replyMap entry", () => {
    const replyMap = new Map([["m0", { id: "m0", authorName: "Bob", content: "hey there" }]])
    const out = mapMessageForApi({ ...baseRow, replyToId: "m0" }, { ...emptyApiCtx, replyMap }, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.replyTo).toEqual({ id: "m0", authorName: "Bob", text: "hey there" })
  })

  it("emits { deleted: true } when replyToId is set but the target is missing (out-of-scope filtered upstream)", () => {
    const out = mapMessageForApi({ ...baseRow, replyToId: "m-gone" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.replyTo).toEqual({ id: "m-gone", authorName: "Deleted user", text: "", deleted: true })
  })

  it("gives API and WS projections the same ellipsized reply preview", () => {
    const long = "x".repeat(500)
    const replyMap = new Map([["m0", { id: "m0", authorName: "Bob", content: long }]])
    const apiOut = mapMessageForApi({ ...baseRow, replyToId: "m0" }, { ...emptyApiCtx, replyMap }, BUSINESS_SCHEMA_VERSION, "channel")
    const wsOut = mapMessageForWs({ ...baseRow, replyToId: "m0" }, { ...emptyWsCtx, replyMap }, BUSINESS_SCHEMA_VERSION, "channel")
    const expected = `${"x".repeat(119)}…`
    expect(apiOut.replyTo?.text).toBe(expected)
    expect(wsOut.replyTo?.text).toBe(expected)
  })

  it("omits attachments/reactions when there are none", () => {
    const out = mapMessageForApi(baseRow, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.attachments).toEqual([])
    expect(out.reactions).toBeUndefined()
  })

  it("passes through UI-shaped attachments and reactions", () => {
    const out = mapMessageForApi(baseRow, {
      ...emptyApiCtx,
      attachmentsByMessage: {
        m1: [{ id: "a", name: "a.png", url: "/a.png", thumbnailUrl: null, contentType: "image/png", sizeBytes: null, width: null, height: null }],
      },
      reactionsByMessage: {
        m1: [{ emoji: "🎉", count: 2, me: true, userIds: ["u_alice", "u_bob"] }],
      },
    }, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.attachments).toEqual([{ id: "a", name: "a.png", url: "/a.png", thumbnailUrl: null, contentType: "image/png", sizeBytes: null, width: null, height: null }])
    expect(out.reactions).toEqual([{ emoji: "🎉", count: 2, me: true, userIds: ["u_alice", "u_bob"] }])
  })

  it("adds thread info only when threadByMessageId hits", () => {
    const threadByMessageId = new Map([["m1", { id: "t1", name: "post title", messageCount: 5 }]])
    const withThread = mapMessageForApi(baseRow, { ...emptyApiCtx, threadByMessageId }, BUSINESS_SCHEMA_VERSION, "channel")
    expect(withThread.thread).toEqual({ id: "t1", name: "post title", messageCount: 5 })

    const withoutThread = mapMessageForApi(baseRow, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(withoutThread.thread).toBeUndefined()
  })

  it("returns client-provided nonces and filters srv fallbacks", () => {
    expect(mapMessageForApi({ ...baseRow, clientNonce: "client-1" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel").clientNonce)
      .toBe("client-1")
    expect(mapMessageForApi({ ...baseRow, clientNonce: "srv:fallback" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel").clientNonce)
      .toBeNull()
    expect(mapMessageForApi({ ...baseRow, clientNonce: null }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel").clientNonce)
      .toBeNull()
  })
})

describe("mapMessageForWs", () => {
  it("preserves the required server seq", () => {
    expect(mapMessageForWs(baseRow, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").seq).toBe(42)
  })

  it("maps ordinary rows to type: \"chat\" (was \"default\" before #12's exhaustive discriminator)", () => {
    expect(mapMessageForWs({ ...baseRow, type: null }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").type).toBe("chat")
    expect(mapMessageForWs({ ...baseRow, type: "default" }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").type).toBe("chat")
    expect(mapMessageForWs({ ...baseRow, type: "system" }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").type).toBe("system")
  })

  it("splits `type: \"thread_created\"` into { type: \"system\", systemKind: \"thread\" } for both mappers", () => {
    const wsOut = mapMessageForWs({ ...baseRow, type: "thread_created" }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(wsOut.type).toBe("system")
    expect(wsOut.systemKind).toBe("thread")

    const apiOut = mapMessageForApi({ ...baseRow, type: "thread_created" }, emptyApiCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(apiOut.type).toBe("system")
    expect(apiOut.systemKind).toBe("thread")
  })

  it("a bare `type: \"system\"` row (no known kind) round-trips to { type: \"system\" } with systemKind omitted", () => {
    const out = mapMessageForWs({ ...baseRow, type: "system" }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.type).toBe("system")
    expect(out.systemKind).toBeUndefined()
  })

  it("carries replyTo and mentionType — regression for the thread-payload skip bug", () => {
    const replyMap = new Map([["m0", { id: "m0", authorName: "Bob", content: "hey there" }]])
    const out = mapMessageForWs(
      { ...baseRow, replyToId: "m0", mentionType: "everyone" },
      { ...emptyWsCtx, replyMap }, BUSINESS_SCHEMA_VERSION, "channel"
    )
    expect(out.replyTo).toEqual({ id: "m0", authorName: "Bob", text: "hey there" })
    expect(out.mentionType).toBe("everyone")
  })

  it("narrows non-array embeds to undefined (WS schema demands unknown[])", () => {
    expect(mapMessageForWs({ ...baseRow, embeds: null }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").embeds).toBeUndefined()
    expect(mapMessageForWs({ ...baseRow, embeds: { foo: 1 } }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").embeds).toBeUndefined()
    expect(mapMessageForWs({ ...baseRow, embeds: [{ url: "x" }] }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").embeds).toEqual([{ url: "x" }])
  })

  it("returns raw attachment shape (id/filename/url/contentType/size)", () => {
    const out = mapMessageForWs(baseRow, {
      ...emptyWsCtx,
      resourceAttachments: [
        { id: "a1", name: "x.png", url: "/x.png", thumbnailUrl: null, contentType: "image/png", sizeBytes: 4096, width: null, height: null },
      ],
    }, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.attachments).toEqual([
      { id: "a1", name: "x.png", url: "/x.png", thumbnailUrl: null, contentType: "image/png", sizeBytes: 4096, width: null, height: null },
    ])
  })

  it("omits attachments when the raw list is empty", () => {
    expect(mapMessageForWs(baseRow, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").attachments).toEqual([])
  })

  it("includes width/height on an image attachment when present on the input", () => {
    const out = mapMessageForWs(baseRow, {
      ...emptyWsCtx,
      resourceAttachments: [
        { id: "a1", name: "x.png", url: "/x.png", thumbnailUrl: null, contentType: "image/png", sizeBytes: 4096, width: 1920, height: 1080 },
      ],
    }, BUSINESS_SCHEMA_VERSION, "channel")
    expect(out.attachments).toEqual([
      { id: "a1", name: "x.png", url: "/x.png", thumbnailUrl: null, contentType: "image/png", sizeBytes: 4096, width: 1920, height: 1080 },
    ])
  })

  it("coerces null content to empty string (attachments-only message)", () => {
    expect(mapMessageForWs({ ...baseRow, content: null }, emptyWsCtx, BUSINESS_SCHEMA_VERSION, "channel").content).toBe("")
  })
})


describe("attachment contract selection", () => {
  it("keeps exact nullable attachment facts only on the current contract", () => {
    const attachment = { id: "attachment", name: "file.bin", url: "/file", thumbnailUrl: null, contentType: null, sizeBytes: null, width: null, height: null }
    const ctx = { ...emptyApiCtx, attachmentsByMessage: { m1: [attachment] } }
    for (const contract of [1, 2, 3, 6]) expect(() => mapMessageForApi(baseRow, ctx, contract, "channel")).toThrow("protocol mismatch")
    expect(mapMessageForApi({ ...baseRow, authorAvatarVersion: 2 }, ctx, BUSINESS_SCHEMA_VERSION, "channel").attachments).toEqual([attachment])
  })
})


describe("single-message creation payload hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    creationMocks.attachments.mockResolvedValue([])
    creationMocks.reactions.mockResolvedValue([])
  })
  it.each(["default", "friend_approval"])("does not query creation requests for %s", async type => {
    await readCommunityMessageResource({} as never, "viewer", { ...baseRow, type, channelId: "dm" }, BUSINESS_SCHEMA_VERSION)
    expect(creationMocks.hydrate).not.toHaveBeenCalled()
  })
  it("hydrates a creation card with the same immutable owner identity", async () => {
    const payload = botCreationFixture()
    creationMocks.hydrate.mockResolvedValue(new Map([[baseRow.id, payload]]))
    const message = await readCommunityMessageResource({} as never, "viewer", { ...baseRow, type: "bot_creation_request", channelId: "dm" }, BUSINESS_SCHEMA_VERSION)
    expect(creationMocks.hydrate).toHaveBeenCalledExactlyOnceWith({}, [baseRow.id], "viewer")
    expect(message.botCreation).toEqual(payload)
    expect(message.botCreation).not.toHaveProperty("canDecide")
  })
})
