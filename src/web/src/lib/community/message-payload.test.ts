import { describe, it, expect } from "vitest"
import { mapMessageForApi, mapMessageForWs, type MessageRow } from "./message-payload"

const baseRow: MessageRow = {
  id: "m1",
  authorId: "u_alice",
  authorName: "Alice",
  authorImage: "https://avatars/alice.png",
  content: "hello",
  type: null,
  mentionType: null,
  replyToId: null,
  embeds: null,
  createdAt: "2026-07-03T12:00:00.000Z",
}

const emptyApiCtx = {
  replyMap: new Map(),
  attachmentsByMessage: {},
  reactionsByMessage: {},
}

const emptyWsCtx = { replyMap: new Map(), attachments: [] }

describe("mapMessageForApi", () => {
  it("returns the core author/content/timestamp fields with avatar fallback", () => {
    const out = mapMessageForApi(baseRow, emptyApiCtx)
    expect(out.id).toBe("m1")
    expect(out.authorName).toBe("Alice")
    expect(out.authorAvatar).toBe("https://avatars/alice.png")
    expect(out.content).toBe("hello")
    expect(out.createdAt).toBe("2026-07-03T12:00:00.000Z")
  })

  it("coerces null content to empty string (message with attachments only)", () => {
    const out = mapMessageForApi({ ...baseRow, content: null }, emptyApiCtx)
    expect(out.content).toBe("")
  })

  it("derives avatarInitial when authorImage is null", () => {
    const out = mapMessageForApi({ ...baseRow, authorImage: null, authorName: "Alice" }, emptyApiCtx)
    expect(out.authorAvatar).toBe("A")
  })

  it("hides `type: default` (undefined) and surfaces `system` verbatim", () => {
    expect(mapMessageForApi({ ...baseRow, type: null }, emptyApiCtx).type).toBeUndefined()
    expect(mapMessageForApi({ ...baseRow, type: "default" }, emptyApiCtx).type).toBeUndefined()
    expect(mapMessageForApi({ ...baseRow, type: "system" }, emptyApiCtx).type).toBe("system")
  })

  it("resolves replyTo from an in-scope replyMap entry", () => {
    const replyMap = new Map([["m0", { id: "m0", authorName: "Bob", content: "hey there" }]])
    const out = mapMessageForApi({ ...baseRow, replyToId: "m0" }, { ...emptyApiCtx, replyMap })
    expect(out.replyTo).toEqual({ id: "m0", authorName: "Bob", text: "hey there" })
  })

  it("emits { deleted: true } when replyToId is set but the target is missing (out-of-scope filtered upstream)", () => {
    const out = mapMessageForApi({ ...baseRow, replyToId: "m-gone" }, emptyApiCtx)
    expect(out.replyTo).toEqual({ id: "m-gone", authorName: "Unknown", text: "", deleted: true })
  })

  it("truncates reply preview text to MESSAGE_PREVIEW_LENGTH", () => {
    const long = "x".repeat(500)
    const replyMap = new Map([["m0", { id: "m0", authorName: "Bob", content: long }]])
    const out = mapMessageForApi({ ...baseRow, replyToId: "m0" }, { ...emptyApiCtx, replyMap })
    expect(out.replyTo?.text.length).toBeLessThan(500)
  })

  it("omits attachments/reactions when there are none", () => {
    const out = mapMessageForApi(baseRow, emptyApiCtx)
    expect(out.attachments).toBeUndefined()
    expect(out.reactions).toBeUndefined()
  })

  it("passes through UI-shaped attachments and reactions", () => {
    const out = mapMessageForApi(baseRow, {
      ...emptyApiCtx,
      attachmentsByMessage: {
        m1: [{ kind: "image", name: "a.png", url: "/a.png" }],
      },
      reactionsByMessage: {
        m1: [{ emoji: "🎉", count: 2, me: true, userIds: ["u_alice", "u_bob"] }],
      },
    })
    expect(out.attachments).toEqual([{ kind: "image", name: "a.png", url: "/a.png" }])
    expect(out.reactions).toEqual([{ emoji: "🎉", count: 2, me: true, userIds: ["u_alice", "u_bob"] }])
  })

  it("adds thread info only when threadByMessageId hits", () => {
    const threadByMessageId = new Map([["m1", { id: "t1", name: "post title", messageCount: 5 }]])
    const withThread = mapMessageForApi(baseRow, { ...emptyApiCtx, threadByMessageId })
    expect(withThread.thread).toEqual({ id: "t1", name: "post title", messageCount: 5 })

    const withoutThread = mapMessageForApi(baseRow, emptyApiCtx)
    expect(withoutThread.thread).toBeUndefined()
  })
})

describe("mapMessageForWs", () => {
  it("returns type: default explicitly (WS convention differs from API)", () => {
    expect(mapMessageForWs({ ...baseRow, type: null }, emptyWsCtx).type).toBe("default")
    expect(mapMessageForWs({ ...baseRow, type: "default" }, emptyWsCtx).type).toBe("default")
    expect(mapMessageForWs({ ...baseRow, type: "system" }, emptyWsCtx).type).toBe("system")
  })

  it("carries replyTo and mentionType — regression for the thread-payload skip bug", () => {
    const replyMap = new Map([["m0", { id: "m0", authorName: "Bob", content: "hey there" }]])
    const out = mapMessageForWs(
      { ...baseRow, replyToId: "m0", mentionType: "everyone" },
      { ...emptyWsCtx, replyMap },
    )
    expect(out.replyTo).toEqual({ id: "m0", authorName: "Bob", text: "hey there" })
    expect(out.mentionType).toBe("everyone")
  })

  it("narrows non-array embeds to undefined (WS schema demands unknown[])", () => {
    expect(mapMessageForWs({ ...baseRow, embeds: null }, emptyWsCtx).embeds).toBeUndefined()
    expect(mapMessageForWs({ ...baseRow, embeds: { foo: 1 } }, emptyWsCtx).embeds).toBeUndefined()
    expect(mapMessageForWs({ ...baseRow, embeds: [{ url: "x" }] }, emptyWsCtx).embeds).toEqual([{ url: "x" }])
  })

  it("returns raw attachment shape (id/filename/url/contentType/size)", () => {
    const out = mapMessageForWs(baseRow, {
      ...emptyWsCtx,
      attachments: [
        { id: "a1", filename: "x.png", url: "/x.png", contentType: "image/png", size: 4096 },
      ],
    })
    expect(out.attachments).toEqual([
      { id: "a1", filename: "x.png", url: "/x.png", contentType: "image/png", size: 4096 },
    ])
  })

  it("omits attachments when the raw list is empty", () => {
    expect(mapMessageForWs(baseRow, emptyWsCtx).attachments).toBeUndefined()
  })

  it("coerces null content to empty string (attachments-only message)", () => {
    expect(mapMessageForWs({ ...baseRow, content: null }, emptyWsCtx).content).toBe("")
  })
})
