import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mockResolve = vi.fn()
const mockGetChannelType = vi.fn()
const mockListTags = vi.fn()
const mockMutateTags = vi.fn()
const mockListReactions = vi.fn()
const mockSetReaction = vi.fn()
const mockRemoveReaction = vi.fn()
const mockIsMessageMarked = vi.fn()
const mockMarkMessage = vi.fn()
const mockUnmarkMessage = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/community/resolve-message-ref", () => ({
  resolveMessageRefForBot: (...args: unknown[]) => mockResolve(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityChannel: {
        ...actual.queries.communityChannel,
        getChannelType: (...args: unknown[]) => mockGetChannelType(...args),
      },
      communityMessageMark: {
        ...actual.queries.communityMessageMark,
        isMessageMarked: (...args: unknown[]) => mockIsMessageMarked(...args),
        markMessage: (...args: unknown[]) => mockMarkMessage(...args),
        unmarkMessage: (...args: unknown[]) => mockUnmarkMessage(...args),
      },
    },
  }
})
vi.mock("@/lib/community/forum-tag-operations", () => ({
  listForumTagsForActor: (...args: unknown[]) => mockListTags(...args),
  mutateForumTagsForActor: (...args: unknown[]) => mockMutateTags(...args),
}))
vi.mock("@/lib/community/reaction-operations", () => ({
  listReactionsForActor: (...args: unknown[]) => mockListReactions(...args),
  setReactionForActor: (...args: unknown[]) => mockSetReaction(...args),
  removeReactionForActor: (...args: unknown[]) => mockRemoveReaction(...args),
}))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: NextRequest, routeCtx?: any) => {
    const actor = req.headers.get("Authorization") === "human"
      ? { kind: "human", userId: "u1" }
      : { kind: "bot", userId: "bot1", ownerUserId: "owner1", machineId: "machine1" }
    return handler(req, { env: { DB: {} }, actor, params: routeCtx?.params })
  },
  requireBot: (actor: any) => actor.kind === "bot"
    ? { ok: true, bot: actor }
    : { ok: false, response: NextResponse.json({ error: "forbidden: bot-only endpoint" }, { status: 403 }) },
}))

import { DELETE, GET, PUT } from "./route"

const ctx = { params: { id: "resolve" } } as any
function getRequest(ref = "/demo#1234/forum", seq = 7, human = false) {
  return new NextRequest(`http://localhost/api/community/messages/resolve/properties?ref=${encodeURIComponent(ref)}&seq=${seq}`, {
    headers: human ? { Authorization: "human" } : undefined,
  })
}
function mutationRequest(method: "PUT" | "DELETE", property: unknown, human = false) {
  return new NextRequest("http://localhost/api/community/messages/resolve/properties", {
    method,
    headers: {
      "content-type": "application/json",
      ...(human ? { Authorization: "human" } : {}),
    },
    body: JSON.stringify({ channel: "/demo#1234/forum", seq: 7, property }),
  })
}

function rawMutationRequest(method: "PUT" | "DELETE", body: unknown) {
  return new NextRequest("http://localhost/api/community/messages/resolve/properties", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("bot message property route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolve.mockResolvedValue({ ok: true, messageId: "m1", channelId: "c1" })
    mockGetChannelType.mockResolvedValue("forum")
    mockListTags.mockResolvedValue({ ok: true, value: ["archived", "bug"] })
    mockMutateTags.mockResolvedValue({ ok: true, value: { tags: ["bug"], changed: true } })
    mockListReactions.mockResolvedValue({ ok: true, value: [] })
    mockSetReaction.mockResolvedValue({ ok: true, value: { emoji: "👍", changed: true } })
    mockRemoveReaction.mockResolvedValue({ ok: true, value: { emoji: "👍", changed: false } })
    mockIsMessageMarked.mockResolvedValue(false)
    mockMarkMessage.mockResolvedValue({ id: "mark1" })
    mockUnmarkMessage.mockResolvedValue({ id: "mark1" })
  })

  it("lists forum tags with the capability envelope", async () => {
    const res = await GET(getRequest(), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      capabilities: ["tag", "mark"],
      properties: [
        { type: "tag", value: ["archived", "bug"] },
        { type: "mark", value: false },
      ],
    })
    expect(mockResolve).toHaveBeenCalledWith({}, "bot1", {
      channel: "/demo#1234/forum",
      seq: 7,
    }, { requireSurfaceAccess: true })
  })

  it("lists deterministic emoji details on a thread message", async () => {
    mockGetChannelType.mockResolvedValue("thread")
    mockListReactions.mockResolvedValue({
      ok: true,
      value: [{ emoji: "👍", actors: ["@a#0001"], me: true }],
    })
    const res = await GET(getRequest("/demo#1234/forum/#7", 2), ctx)
    expect(await res.json()).toEqual({
      capabilities: ["emoji", "mark"],
      properties: [
        { type: "emoji", value: [{ emoji: "👍", actors: ["@a#0001"], me: true }] },
        { type: "mark", value: false },
      ],
    })
  })

  it("rejects a non-resolve route id for reads and mutations", async () => {
    const directCtx = { params: { id: "m1" } } as any
    const read = await GET(getRequest(), directCtx)
    const write = await PUT(mutationRequest("PUT", { type: "mark", value: true }), directCtx)
    expect(read.status).toBe(404)
    expect(write.status).toBe(404)
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it("masks invalid channel types and failed target resolution on reads", async () => {
    mockGetChannelType.mockResolvedValueOnce("category")
    const invalidType = await GET(getRequest(), ctx)
    expect(invalidType.status).toBe(404)
    expect(await invalidType.json()).toEqual({ error: "message not found" })

    mockResolve.mockResolvedValueOnce({ ok: false, status: 404, error: "channel not found" })
    const missing = await GET(getRequest(), ctx)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "channel not found" })
  })

  it("propagates tag and emoji listing failures", async () => {
    mockListTags.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })
    const tags = await GET(getRequest(), ctx)
    expect(tags.status).toBe(403)
    expect(await tags.json()).toEqual({ error: "forbidden" })

    mockGetChannelType.mockResolvedValueOnce("thread")
    mockListReactions.mockResolvedValueOnce({ ok: false, status: 404, error: "message not found" })
    const emoji = await GET(getRequest("/demo#1234/forum/#7", 2), ctx)
    expect(emoji.status).toBe(404)
    expect(await emoji.json()).toEqual({ error: "message not found" })
  })

  it("sets and removes tag deltas through the existing tag operation", async () => {
    mockMutateTags.mockResolvedValue({
      ok: true,
      value: { tags: ["existing", "new"], changed: true },
    })
    const setRes = await PUT(mutationRequest("PUT", {
      type: "tag",
      value: [" Existing ", " NEW "],
    }), ctx)
    expect(await setRes.json()).toEqual({
      type: "tag",
      value: ["existing", "new"],
      changed: true,
    })
    expect(mockMutateTags).toHaveBeenCalledWith({}, {
      messageId: "m1",
      userId: "bot1",
      action: "set",
      tags: [" Existing ", " NEW "],
    })

    mockMutateTags.mockResolvedValue({ ok: true, value: { tags: [], changed: false } })
    const removeRes = await DELETE(mutationRequest("DELETE", { type: "tag", value: ["missing"] }), ctx)
    expect(await removeRes.json()).toEqual({ type: "tag", value: [], changed: false })
  })

  it("propagates tag mutation errors and executes emoji set/remove semantics", async () => {
    mockMutateTags.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })
    const deniedTag = await PUT(mutationRequest("PUT", { type: "tag", value: ["bug"] }), ctx)
    expect(deniedTag.status).toBe(403)
    expect(await deniedTag.json()).toEqual({ error: "forbidden" })

    mockGetChannelType.mockResolvedValue("thread")
    const setEmoji = await PUT(mutationRequest("PUT", { type: "emoji", value: "👍" }), ctx)
    expect(await setEmoji.json()).toEqual({ type: "emoji", value: "👍", changed: true })
    expect(mockSetReaction).toHaveBeenCalledWith({}, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })

    const removeEmoji = await DELETE(mutationRequest("DELETE", { type: "emoji", value: "👍" }), ctx)
    expect(await removeEmoji.json()).toEqual({ type: "emoji", value: "👍", changed: false })
    expect(mockRemoveReaction).toHaveBeenCalledWith({}, {
      messageId: "m1",
      userId: "bot1",
      emoji: "👍",
    })

    mockSetReaction.mockResolvedValueOnce({ ok: false, status: 400, error: "emoji too long" })
    const invalidEmoji = await PUT(mutationRequest("PUT", { type: "emoji", value: "oversized" }), ctx)
    expect(invalidEmoji.status).toBe(400)
    expect(await invalidEmoji.json()).toEqual({ error: "emoji too long" })
  })

  it("sets, lists, and removes the calling bot's universal mark", async () => {
    const setRes = await PUT(mutationRequest("PUT", { type: "mark", value: true }), ctx)
    expect(await setRes.json()).toEqual({ type: "mark", value: true, changed: true })
    expect(mockMarkMessage).toHaveBeenCalledWith({}, {
      userId: "bot1",
      channelId: "c1",
      messageId: "m1",
    })

    mockIsMessageMarked.mockResolvedValue(true)
    const listRes = await GET(getRequest(), ctx)
    expect((await listRes.json()).properties).toContainEqual({ type: "mark", value: true })

    const removeRes = await DELETE(mutationRequest("DELETE", { type: "mark", value: true }), ctx)
    expect(await removeRes.json()).toEqual({ type: "mark", value: true, changed: true })
    expect(mockUnmarkMessage).toHaveBeenCalledWith({}, {
      userId: "bot1",
      messageId: "m1",
    })
  })

  it("rejects false as a mark mutation value without writing", async () => {
    const res = await PUT(mutationRequest("PUT", { type: "mark", value: false }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "mark value must be true" })
    expect(mockMarkMessage).not.toHaveBeenCalled()
  })

  it("rejects a property outside the target capability after resolving access", async () => {
    mockGetChannelType.mockResolvedValue("thread")
    const res = await PUT(mutationRequest("PUT", { type: "tag", value: ["bug"] }), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "property type 'tag' is not supported for thread messages",
      hint: "supported property types: emoji, mark",
    })
    expect(mockResolve).toHaveBeenCalled()
    expect(mockMutateTags).not.toHaveBeenCalled()
  })

  it("rejects extra property fields and unknown types", async () => {
    const extra = await PUT(mutationRequest("PUT", { type: "tag", value: ["bug"], actor: "u2" }), ctx)
    expect(extra.status).toBe(400)
    expect(mockMutateTags).not.toHaveBeenCalled()

    const unknown = await PUT(mutationRequest("PUT", { type: "color", value: "blue" }), ctx)
    expect(unknown.status).toBe(400)
  })

  it("rejects extra top-level fields only after resolving the target mask", async () => {
    const res = await PUT(rawMutationRequest("PUT", {
      channel: "/demo#1234/forum",
      seq: 7,
      property: { type: "tag", value: ["bug"] },
      actor: "u2",
    }), ctx)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "request must contain exactly channel, seq, and property",
    })
    expect(mockResolve).toHaveBeenCalled()
    expect(mockMutateTags).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON, non-object requests, and non-object properties", async () => {
    const malformed = new NextRequest("http://localhost/api/community/messages/resolve/properties", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    const malformedRes = await PUT(malformed, ctx)
    expect(malformedRes.status).toBe(400)
    expect(await malformedRes.json()).toEqual({ error: "invalid JSON body" })

    const primitiveRequest = await PUT(rawMutationRequest("PUT", null), ctx)
    expect(primitiveRequest.status).toBe(400)
    expect(await primitiveRequest.json()).toEqual({
      error: "request must contain exactly channel, seq, and property",
    })

    const primitiveProperty = await PUT(mutationRequest("PUT", null), ctx)
    expect(primitiveProperty.status).toBe(400)
    expect(await primitiveProperty.json()).toEqual({ error: "property must be an object" })
  })

  it("preserves the target existence mask before property validation", async () => {
    mockResolve.mockResolvedValue({ ok: false, status: 404, error: "channel not found" })
    const res = await PUT(mutationRequest("PUT", { type: "tag", value: "wrong" }), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "channel not found" })
    expect(mockMutateTags).not.toHaveBeenCalled()
  })

  it("is bot-only", async () => {
    const res = await GET(getRequest("/demo#1234/forum", 7, true), ctx)
    expect(res.status).toBe(403)
    const mutation = await PUT(mutationRequest("PUT", { type: "mark", value: true }, true), ctx)
    expect(mutation.status).toBe(403)
    expect(mockResolve).not.toHaveBeenCalled()
  })
})
