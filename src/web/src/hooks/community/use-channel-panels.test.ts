import { forumFeedScenarioFixture, fullResourceBundleFixture, serverResourceFixture, channelResourceFixture, messageResourceFixture } from "@/test/community-resource-fixtures"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { type QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { getCanonicalCommunityMessages, getCanonicalCommunityChannels, ingestMessages } from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { channelSchema } from "@/lib/community-db/schema"
import { materializeThreadsResponse, type ThreadsResponse } from "./use-channel-panels"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

let qc: QueryClient
beforeEach(async () => {
  apiFetchMock.mockReset()
  qc = (await createCommunityQueryOwner()).client
})
const project = (data: ThreadsResponse) => materializeThreadsResponse(data, new Map(getCanonicalCommunityMessages(qc).map((row) => [row.id, row])), new Map(getCanonicalCommunityChannels(qc).map((row) => [row.id, row])))

function page(channelId = "ch_1", parentType: "text" | "forum" = "forum", threadId = "t_1", openerId = "m1", name = "thread", content = "root", preview?: string) {
  return forumFeedScenarioFixture(channelId, { serverId: "s1", parentType, threads: [{ id: threadId, name, creatorId: "u1", parentMessageId: openerId, messageCount: 1, lastMessageAt: null, createdAt: "now" }],
    included: { parentMessages: [{ id: openerId, channelId, content, seq: 1, authorId: "u1", authorName: "Alice", authorAvatar: null }],
      firstMessages: preview === undefined ? [] : [{ channelId: threadId, content: preview }],
      participants: [{ channelId: threadId, userId: "u1", userName: "Alice", userImage: null, userAvatarVersion: 0 }],
    }, hasMore: false,
  })
}
function pins(message = messageResourceFixture({ id: "m_1", channelId: "ch_1", authorId: "u1", content: "pin", createdAt: "now" })) {
  return { pins: [{ id: message.id }], resources: fullResourceBundleFixture("viewer", [serverResourceFixture({ id: "s1" })], [channelResourceFixture({ id: "ch_1" })], [message]) }
}

describe("useThreads / threadsQueryFn", () => {
  it("publishes complete participant numbers without a DM read", async () => {
    const { threadsQueryFn } = await import("./use-channel-panels")
    for (const discriminator of ["123456", "654321"]) {
      const current = page()
      current.included.profiles = current.included.profiles.map(profile => ({ ...profile, discriminator }))
      apiFetchMock.mockReset(); apiFetchMock.mockResolvedValueOnce(current)
      await threadsQueryFn("ch_1", qc)()
      expect(getCommunityDbRegistry(qc)!.collections.profiles.get("u1")).toMatchObject({ name: "Alice", discriminator })
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
      expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("/dm"))).toBe(false)
    }
  })

  it("rejects an incomplete raw current profile before publishing any thread", async () => {
    const raw = page()
    const { discriminator: _discriminator, ...partial } = raw.included.profiles[0]
    raw.included.profiles[0] = partial as never
    apiFetchMock.mockResolvedValueOnce(raw)
    const { threadsQueryFn } = await import("./use-channel-panels")
    await expect(threadsQueryFn("ch_1", qc)()).rejects.toThrow()
    expect(getCommunityDbRegistry(qc)!.collections.channels.has("t_1")).toBe(false)
    expect(getCommunityDbRegistry(qc)!.collections.profiles.has("u1")).toBe(false)
  })

  it("fetches one full threads page and returns its owned ID window", async () => {
    apiFetchMock.mockResolvedValueOnce(page("ch_1", "forum", "t_1", "m1", "t", "root", "Full first message preview"))
    const { threadsQueryFn } = await import("./use-channel-panels")
    const data = await threadsQueryFn("ch_1", qc)()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/threads?include=parentMessage,firstMessage,tags,participants&archived=false", expect.objectContaining({ authenticationAccount: "viewer", signal: undefined }))
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/community/channels/ch_1/posts")
    expect(data.threads).toHaveLength(1)
    expect(project(data)[0]?.parent.text).toBe("Full first message preview")
  })

  it("populates queryClient at communityKeys.threads(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce(page("ch_1", "text", "t_1", "m_1"))
    const { threadsQueryFn } = await import("./use-channel-panels")
    const key = communityKeys.threads("ch_1")
    await qc.query({ queryKey: key, queryFn: threadsQueryFn("ch_1", qc) })
    expect(qc.getQueryData<{ threads: unknown[] }>(key)?.threads).toHaveLength(1)
  })

  it("uses full opener content only for forum parents with the original AbortSignal", async () => {
    const signal = new AbortController().signal
    apiFetchMock.mockResolvedValueOnce(page("forum_1", "forum", "post_1", "opener_1", "derived", "  Full opener content  "))
    const { threadsQueryFn } = await import("./use-channel-panels")
    const forum = await threadsQueryFn("forum_1", qc)({ signal })
    expect(project(forum)[0]).toMatchObject({ name: "  Full opener content  ", openerMessageId: "opener_1" })
    expect(apiFetchMock.mock.calls).toHaveLength(1)
    expect(apiFetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ signal }))
    apiFetchMock.mockReset(); apiFetchMock.mockResolvedValueOnce(page("text_1", "text", "thread_1", "root_1", "Custom thread name", "Root message"))
    const text = await threadsQueryFn("text_1", qc)()
    expect(project(text)[0]?.name).toBe("Custom thread name")
  })

  it("aborts the full resource loader when its exact base query is cancelled", async () => {
    const signals: AbortSignal[] = []
    apiFetchMock.mockImplementation((_url: string, init: RequestInit = {}) => {
      const signal = init.signal as AbortSignal; signals.push(signal)
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
    })
    const { threadsQueryFn } = await import("./use-channel-panels")
    const key = communityKeys.threads("forum_1")
    const pending = qc.query({ queryKey: key, queryFn: threadsQueryFn("forum_1", qc) }).catch(() => undefined)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    await qc.cancelQueries({ queryKey: key, exact: true })
    expect(new Set(signals).size).toBe(1); expect(signals[0].aborted).toBe(true)
    await pending
  })
})

describe("usePins / pinsQueryFn", () => {
  it("publishes rich pin facts only from the supplied full resource", async () => {
    const rich = messageResourceFixture({ id: "m_1", channelId: "ch_1", replyToId: "reply", type: "system" as const, systemKind: "thread" as const,
      authorId: "u1", content: "full", clientNonce: "known-nonce",
      replyTo: { id: "reply", authorName: "Peer", text: "Prior" },
      attachments: [{ id: "file", name: "known.txt", url: "/known", thumbnailUrl: null, contentType: "text/plain", sizeBytes: 1024, width: null, height: null }],
      embeds: [{ title: "Known" }], reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["peer"] }],
    })
    ingestMessages(getCommunityDbRegistry(qc)!, "ch_1", [rich])
    apiFetchMock.mockResolvedValueOnce(pins({ ...rich, content: "summary" }))
    const { pinsQueryFn } = await import("./use-channel-panels")
    await pinsQueryFn("ch_1", qc)()
    expect(getCommunityDbRegistry(qc)!.collections.messages.get(rich.id)).toMatchObject({
      ...rich, content: "summary", replyToId: "reply",
    })
  })
  it("rejects an incomplete raw pin resource without inventing a canonical body", async () => {
    const raw = pins()
    raw.resources.messages[0] = { id: "m_1", channelId: "ch_1", content: "partial" } as never
    apiFetchMock.mockResolvedValueOnce(raw)
    const { pinsQueryFn } = await import("./use-channel-panels")
    await expect(pinsQueryFn("ch_1", qc)()).rejects.toThrow()
    expect(getCommunityDbRegistry(qc)!.collections.messages.has("m_1")).toBe(false)
  })

  it("fetches from /channels/:id/pins and returns { pins }", async () => {
    apiFetchMock.mockResolvedValueOnce(pins())
    const { pinsQueryFn } = await import("./use-channel-panels")
    const data = await pinsQueryFn("ch_1", qc)()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/ch_1/pins", expect.objectContaining({ authenticationAccount: "viewer" }))
    expect(data.pins).toHaveLength(1)
  })

  it("populates queryClient at communityKeys.pins(channelId)", async () => {
    apiFetchMock.mockResolvedValueOnce(pins())
    const { pinsQueryFn } = await import("./use-channel-panels")
    const key = communityKeys.pins("ch_1")
    await qc.query({ queryKey: key, queryFn: pinsQueryFn("ch_1", qc) })
    expect(qc.getQueryData<{ pins: unknown[] }>(key)?.pins).toHaveLength(1)
  })
})

describe("materializeThreadsResponse", () => {
  it("retains full forum previews, text-panel limits, created-time fallback and optional opener fields", () => {
    const preview = "preview".repeat(30), content = "content".repeat(30)
    const base = { ...channelResourceFixture({ id: "base", serverId: "s1", type: "thread", parentChannelId: "forum" }), muted: false, pending: false, tags: [] }
    const channels = new Map([
      ["post", channelSchema.parse({ ...base, id: "post", name: "Fallback", createdAt: "created", preview, parentMessageId: "opener" })],
      ["empty", channelSchema.parse({ ...base, id: "empty", name: "", preview, createdAt: "created" })],
      ["archived", channelSchema.parse({ ...base, id: "archived", name: "Archived", archived: true })],
    ])
    const data = { parentType: "forum", serverId: "s1", parentChannelId: "forum", threads: [{ id: "post", openerMessageId: "opener" }, { id: "empty" }, { id: "archived" }] }
    const messages = new Map([["opener", { id: "opener", type: "chat" as const, content: "   ", authorId: "u1", authorName: "A", seq: 0 }]])
    const forum = materializeThreadsResponse(data, messages, channels)
    expect(forum).toHaveLength(2)
    expect(forum[0]).toEqual({ id: "post", name: "Fallback", messageCount: 0, lastMessageAt: "created", parent: { authorId: "u1", authorName: "A", text: preview }, parentSeq: 0, openerMessageId: "opener" })
    expect(forum[1]).toMatchObject({ name: "Post", lastMessageAt: "created", parent: { authorName: "", text: preview } })
    expect(forum[1]).not.toHaveProperty("parentSeq")
    expect(forum[1]).not.toHaveProperty("openerMessageId")
    messages.set("opener", { ...messages.get("opener")!, content })
    expect(materializeThreadsResponse({ ...data, parentType: "text" }, messages, channels)[0]).toMatchObject({ name: "Fallback", parent: { text: content.slice(0, 100) } })
  })
  it("filters missing openers and projects forum and text content from canonical rows", async () => {
    const { materializeThreadsResponse } = await import("./use-channel-panels")
    const base = {
      parentType: "forum" as const,
      serverId: "s1",
      parentChannelId: "forum_1",
      threads: [
        { id: "missing", name: "missing", messageCount: 0, lastMessageAt: "now", parent: { authorName: "", text: "preview" }, openerMessageId: "missing-opener" },
        { id: "post", name: "fallback", messageCount: 1, lastMessageAt: "now", parent: { authorName: "", text: "preview" }, openerMessageId: "opener" },
        { id: "identityless", name: "identityless", messageCount: 0, lastMessageAt: "now", parent: { authorName: "", text: "preview" } },
      ],
    }
    const canonical = new Map([["opener", { id: "opener", type: "chat" as const, authorId: "u1", authorName: "A", content: "Canonical title", createdAt: "now" }]])

    const channels = new Map(base.threads.map((thread) => [thread.id, channelSchema.parse({ ...channelResourceFixture({ id: thread.id, serverId: "s1", type: "thread", parentChannelId: "forum_1" }), id: thread.id, name: thread.id === "identityless" ? "Post" : thread.name, type: "thread", position: 0, archived: false, muted: false, pending: false, tags: [], serverId: "s1", parentChannelId: "forum_1", parentMessageId: thread.openerMessageId ?? null, preview: thread.parent.text, messageCount: thread.messageCount, lastMessageAt: thread.lastMessageAt })]))
    expect(materializeThreadsResponse(base, canonical, channels).map(({ name }) => name))
      .toEqual(["Canonical title", "Post"])
    expect(materializeThreadsResponse({ ...base, parentType: "text" }, canonical, channels)[0]?.parent.text)
      .toBe("Canonical title")
  })
})
