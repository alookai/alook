import { canonicalMessageReader } from "@/test/community-query-owner"
import { materializeMessageStream } from "@/lib/community/message-stream"
import { createElement, type PropsWithChildren } from "react"
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/lib/community/models/message"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestMessages } from "@/lib/community-db/sync"

const apiFetchMock = vi.fn(), toastMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  toastApiError: (error: unknown, fallback: string) => toastMock(error instanceof Error && error.message ? error.message : fallback),
}))
vi.mock("sonner", () => ({ toast: Object.assign((...args: unknown[]) => toastMock(...args), { error: (...args: unknown[]) => toastMock(...args), success: (...args: unknown[]) => toastMock(...args) }) }))
let capturedQc: QueryClient, canonicalRegistry: CommunityDbRegistry
let active: { mutateAsync: (args: never) => Promise<unknown> }
function Owner({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client: capturedQc }, createElement(CommunityDbProvider, { registry: canonicalRegistry }, children)) }
function mountHook<T>(hook: () => T): T {
  const rendered = renderHook(hook, { wrapper: Owner })
  const value = rendered.result.current
  if (value && typeof value === "object" && "mutateAsync" in value) active = value as typeof active
  return value
}
async function runMutation<Args>(args: Args) {
  let data: unknown
  await act(async () => { data = await active.mutateAsync(args as never) })
  return { data }
}
function startMutation<Args>(args: Args) {
  let pending!: Promise<unknown>
  act(() => { pending = active.mutateAsync(args as never).catch((error) => error) })
  return pending
}
async function loadMod() { return import("./messages") }

function makeCache(msgs: Array<{ id: string } & Record<string, unknown>> = []) {
  return {
    pages: [{ ids: msgs.map((msg) => msg.id), hasMore: false }],
    pageParams: [null],
  }
}

function postedMessage(id: string, seq: number) {
  return {
    id,
    seq,
    createdAt: "2026-08-07T10:00:00.000Z",
    content: "canonical content",
    authorId: "u_me",
    authorName: "Canonical Name",
    authorImage: "https://avatar.test/me.png",
    type: "default",
    embeds: [{ title: "Canonical embed" }],
  }
}

function sidebarData(threadId = "post_1") {
  return {
    channels: [],
    included: { parentMessages: [] },
    serverNow: "2026-08-07T00:00:00.000Z",
    serverClockOffsetMs: 0,
    threads: [{
      id: threadId,
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
      title: "Old title",
      activityAt: "2026-08-06T00:00:00.000Z",
      expiresAt: "2026-08-09T00:00:00.000Z",
      unread: false,
    }],
  }
}

async function seedParent(type: "forum" | "text", parentId = "forum_1") {
  const sync = await import("@/lib/community-db/sync")
  sync.ingestServers(canonicalRegistry, { servers: [{ id: "s1", name: "Server", initial: "S", active: false, unread: false, mentions: 0, ownerId: "u_me" }] })
  sync.ingestServerDetail(canonicalRegistry, { id: "s1", name: "Server", discriminator: "0001", description: "", icon: null, ownerId: "u_me", categories: [{ id: "cat_1", name: "Category", channels: [{ id: parentId, name: "Parent", active: false, unread: false, type }] }] })
  capturedQc.setQueryData(communityKeys.server("s1"), "s1")
}
beforeEach(async () => {
  apiFetchMock.mockReset(); toastMock.mockReset()
  capturedQc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  canonicalRegistry = createCommunityDbRegistry(capturedQc, "u_me")
  await canonicalRegistry.preload()
})
afterEach(async () => { await capturedQc.cancelQueries(); await canonicalRegistry.cleanup(); capturedQc.clear() })
async function installCanonicalRegistry() { await canonicalRegistry.ready }

function attentionIncluded(overrides: {
  messages?: Array<Record<string, unknown>>
  profiles?: Array<Record<string, unknown>>
} = {}) {
  return {
    servers: [{ id: "s_1", name: "Server", discriminator: "0001" }],
    channels: [{
      id: "channel", serverId: "s_1", name: "Channel", type: "text",
      parentChannelId: null, parentMessageId: null, creatorId: null,
      archived: false, lastMessageAt: null,
    }, {
      id: "ch_1", serverId: "s_1", name: "Channel", type: "text",
      parentChannelId: null, parentMessageId: null, creatorId: null,
      archived: false, lastMessageAt: null,
    }],
    dms: [],
    profiles: overrides.profiles ?? [],
    messages: overrides.messages ?? [],
  }
}

async function seedCanonicalParent(type: "forum" | "text") {
  if (!canonicalRegistry) throw new Error("canonical test registry is not active")
  const sync = await import("@/lib/community-db/sync")
  sync.ingestServers(canonicalRegistry, { servers: [{
    id: "s1", name: "Server", initial: "S", active: false, unread: false,
    mentions: 0, ownerId: "u_me",
  }] })
  sync.ingestServerDetail(canonicalRegistry, {
    id: "s1", name: "Server", discriminator: "0001", description: "",
    icon: null, ownerId: "u_me", categories: [{
      id: "cat_1", name: "Category", channels: [{
        id: "forum_1", name: "Parent", active: false, unread: false, type,
      }],
    }],
  })
}

async function seedCanonicalSidebar() {
  await seedCanonicalParent("forum")
  const sync = await import("@/lib/community-db/sync")
  sync.publishCommunityForumSidebar(capturedQc, {
    serverId: "s1",
    channels: [{
      id: "post_1", name: "Post", parentChannelId: "forum_1",
      parentMessageId: "opener_1", activityAt: "2026-08-06T00:00:00.000Z",
      unread: false, type: "thread",
    }],
    openers: [{ id: "opener_1", channelId: "forum_1", content: "Old title", type: "chat" }],
    proof: {
      token: sync.captureCommunityLiveSnapshotToken(capturedQc),
      signal: undefined,
    },
  })
}

async function canonicalSidebar() {
  const { getForumSidebarBase } = await import("../use-forum-sidebar-threads")
  return getForumSidebarBase(capturedQc, "s1")
}

describe("useEditMessage", () => {
  it("optimistically patches content and rolls back when PATCH fails", async () => {
    const key = communityKeys.channelMessages("ch_1")
    const messageKey = communityKeys.message("m1")
    capturedQc.setQueryData(key, makeCache([{ id: "m1", content: "old" }]))
    capturedQc.setQueryData(messageKey, "m1")
    ingestMessages(canonicalRegistry, "ch_1", [{ id: "m1", type: "chat", content: "old" }])
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mountHook(() => mod.useEditMessage())

    await runMutation({ serverId: "s1", channelId: "ch_1", messageId: "m1", content: "new" }).catch(() => {})

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ content: "new" }),
      assertActive: expect.any(Function), authenticationAccount: "u_me",
    }))
    expect(canonicalRegistry.collections.messages.get("m1")?.content).toBe("old")
    expect(capturedQc.getQueryData(messageKey)).toBe("m1")
    expect(capturedQc.getQueryData(key)).toEqual(makeCache([{ id: "m1" }]))
  }, 60_000)

  it("optimistically patches the single-message cache used by a post header", async () => {
    const messageKey = communityKeys.message("opener_1")
    capturedQc.setQueryData(messageKey, "opener_1")
    ingestMessages(canonicalRegistry, "forum_1", [{ id: "opener_1", type: "chat", content: "Old title" }])
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mountHook(() => mod.useEditMessage())

    await runMutation({
      serverId: "s1", channelId: "forum_1", messageId: "opener_1", content: "New title", forumChannelId: "forum_1",
    })

    expect(canonicalRegistry.collections.messages.get("opener_1")?.content).toBe("New title")
    expect(capturedQc.getQueryData(messageKey)).toBe("opener_1")
  })

  it("updates the canonical opener without invalidating unrelated feed transports", async () => {
    const threads = communityKeys.threads("forum_1")
    const feed = communityKeys.forumFeed("forum_1", "bug")
    const inbox = communityKeys.inboxUnreads()
    capturedQc.setQueryData(threads, { serverId: "s1", parentType: "forum", parentChannelId: "forum_1", threads: [] })
    capturedQc.setQueryData(feed, { pages: [], pageParams: [] })
    capturedQc.setQueryData(inbox, { servers: [], dms: [] })
    await seedCanonicalSidebar()
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mountHook(() => mod.useEditMessage())

    await runMutation({
      serverId: "s1", channelId: "forum_1", messageId: "opener_1", content: "new",
      forumChannelId: "forum_1", forumThreadId: "post_1",
    })

    expect(canonicalRegistry.collections.messages.get("opener_1")?.content).toBe("new")
    expect((await canonicalSidebar()).threads[0]?.title).toBe("new")
    expect(capturedQc.getQueryState(threads)?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryState(inbox)?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryState(feed)?.isInvalidated).toBe(false)
  })

  it("patches a loaded forum-sidebar title after the opener edit succeeds", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    await installCanonicalRegistry()
    await seedCanonicalSidebar()
    mountHook(() => mod.useEditMessage())

    await runMutation({
      serverId: "s1",
      channelId: "forum_1",
      messageId: "opener_1",
      content: "New title",
      forumChannelId: "forum_1",
      forumThreadId: "post_1",
    })

    expect((await canonicalSidebar()).threads[0]?.title).toBe("New title")
  })
})

// ── useSendMessage ────────────────────────────────────────────────────────

describe("useSendMessage — happy path", () => {
  it.each([
    ["POST→WS→base", ["post", "ws", "base"]],
    ["WS→POST→base", ["ws", "post", "base"]],
    ["base→POST→WS", ["base", "post", "ws"]],
    ["WS→base→POST", ["ws", "base", "post"]],
    ["POST→matching GET base", ["post", "matchingBase"]],
    ["matching GET base→POST", ["matchingBase", "post"]],
  ] as const)("keeps one rich confirmed row and releases previews once for %s", async (_name, stages) => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    const runtime = canonicalRegistry.runtime
    runtime.ui.actions.setCurrentServerId(scope.serverId)
    runtime.ui.actions.subscribe({ channelId: scope.id })
    const replyTo = { id: "reply_1", authorName: "Reply Author", text: "preview" }
    const attachment = { id: "file_1", filename: "notes.txt", contentType: "text/plain", size: 1024 }
    const remoteAttachment = { kind: "file" as const, name: attachment.filename,
      url: "/api/community/channels/ch_1/attachments/file_1", contentType: attachment.contentType,
      sizeBytes: attachment.size, size: "1.0 KB" }
    const revoke = vi.fn(), originalRevoke = URL.revokeObjectURL
    URL.revokeObjectURL = revoke
    try {
      runtime.messageStream.actions.accept(scope, { nonce: "n1", tempId: "temp_n1",
        message: { type: "chat", content: "optimistic", authorId: "u_me", replyTo },
        localUploads: [{ file: new File(["local"], "notes.txt", { type: "text/plain" }), previewObjectUrl: "blob:owned" }],
      })
      runtime.messageStream.actions.dispatch(scope, { type: "uploadSettled", nonce: "n1", attachments: [remoteAttachment] })
      let release!: (value: { message: ReturnType<typeof postedMessage> }) => void
      apiFetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const mod = await loadMod()
      mountHook(() => mod.useSendMessage())
      const pending = startMutation({ serverId: scope.serverId, channelId: scope.id,
        content: "hi", nonce: "n1", replyTo, attachments: [attachment] })
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
      const { dispatchCommunityWsEvent } = await import("@/hooks/community/community-ws/registry")
      const { getMessageStreamState } = await import("@/test/community-query-owner")
      const { materializeMessageStream } = await import("@/lib/community/message-stream")
      const older = { id: "older", seq: 1, type: "chat" as const, content: "anchor", authorId: "peer", createdAt: "2026-08-07T09:00:00.000Z" }
      let currentBase: import("@/lib/community/message-stream").CanonicalMessage[] = [older]
      for (const stage of stages) {
        if (stage === "post") {
          await act(async () => { release({ message: postedMessage("server_id_1", 9) }); await pending })
          expect(getMessageStreamState(capturedQc, scope).liveIds).toContain("server_id_1")
          expect(materializeMessageStream([], getMessageStreamState(capturedQc, scope), canonicalMessageReader(capturedQc)).find(row => row.id === "server_id_1")).toMatchObject({
            id: "server_id_1", seq: 9, authorName: "Canonical Name", content: "canonical content",
            authorAvatar: "https://avatar.test/me.png", createdAt: "2026-08-07T10:00:00.000Z",
            embeds: [{ title: "Canonical embed" }], replyTo, attachments: [remoteAttachment], clientNonce: "n1", failed: false,
          })
        } else if (stage === "ws") {
          await act(async () => { dispatchCommunityWsEvent({ type: "community:message.create", serverId: scope.serverId,
            channelId: scope.id, message: { id: "server_id_1", seq: 9, type: "chat", authorId: "u_me",
              authorName: "Canonical Name", authorAvatar: "https://avatar.test/me.png", authorAvatarVersion: 0, content: "canonical content",
              createdAt: "2026-08-07T10:00:00.000Z", clientNonce: "n1", replyTo,
              embeds: [{ title: "Canonical embed" }],
              attachments: [{ ...attachment, url: remoteAttachment.url }],
            } }, { deliveryMode: "single", queryClient: capturedQc, communityStore: runtime.ui, wsStore: runtime.ws,
              sub: { channelId: scope.id }, viewerUserIdRef: { current: "u_me" },
              matchesFocus: event => event.channelId === scope.id, scheduleInboxInvalidate: vi.fn() }) })
        } else if (stage === "matchingBase") {
          const { channelMessagesQueryFn } = await import("@/hooks/community/use-messages")
          const { decodeCommunityReadResponse } = await import("@/lib/community/read-response")
          const path = `/api/community/channels/${scope.id}/messages`
          const confirmed = { id: "server_id_1", seq: 9, type: "chat", authorId: "u_me",
            authorName: "Canonical Name", authorAvatar: "https://avatar.test/me.png", authorAvatarVersion: 0,
            content: "canonical content", createdAt: "2026-08-07T10:00:00.000Z", clientNonce: "n1", replyTo,
            embeds: [{ title: "Canonical embed" }], attachments: [remoteAttachment] }
          apiFetchMock.mockResolvedValueOnce(decodeCommunityReadResponse(path, "GET", new Response(),
            { messages: [older, confirmed], latestSeq: 9, hasMore: false }))
          await act(async () => { await channelMessagesQueryFn(scope.id, undefined, { queryClient: capturedQc })({ pageParam: { mode: "newest" } })
            const canonical = canonicalRegistry.collections.messages.get(confirmed.id)
            if (typeof canonical?.seq !== "number") throw new Error("Missing confirmed canonical seq")
            currentBase = [older, { ...canonical, seq: canonical.seq }]
            runtime.messageStream.actions.dispatch(scope, { type: "baseChanged", messages: currentBase, latestSeq: 9 }) })
          expect(canonicalRegistry.collections.messages.get(confirmed.id)?.attachments).toEqual([remoteAttachment])
          expect(materializeMessageStream(currentBase, getMessageStreamState(capturedQc, scope), canonicalMessageReader(capturedQc))).toEqual([
            expect.objectContaining({ id: older.id }),
            expect.objectContaining({ id: confirmed.id, replyTo, attachments: [remoteAttachment] }),
          ])
        } else {
          await act(async () => { ingestMessages(canonicalRegistry, scope.id, [older])
            runtime.messageStream.actions.dispatch(scope, { type: "baseChanged", messages: [older], latestSeq: 100 }) })
        }
      }
      const overlay = getMessageStreamState(capturedQc, scope)
      expect(overlay.outboxByNonce.size).toBe(0)
      expect(materializeMessageStream(currentBase, overlay, canonicalMessageReader(capturedQc)).filter(row => row.id === "server_id_1")).toEqual([
        expect.objectContaining({ seq: 9, content: "canonical content", replyTo, attachments: [remoteAttachment],
          ...(!stages.some(stage => stage === "matchingBase") ? { failed: false } : {}) }),
      ])
      expect(materializeMessageStream(currentBase, overlay, canonicalMessageReader(capturedQc)).find(row => row.id === "server_id_1")?.failed).not.toBe(true)
      runtime.messageStream.actions.dispatch(scope, { type: "baseChanged", messages: [older], latestSeq: 100 })
      runtime.messageStream.actions.removeScope(scope)
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:owned")
    } finally { URL.revokeObjectURL = originalRevoke }
  })

  it("keeps Query base-only and acknowledges the accepted overlay intent", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })

    const mod = await loadMod()
    const stream = await import("@/test/community-query-owner")
    canonicalRegistry.runtime.messageStream.actions.accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi", authorId: "u_me" }, localUploads: [] },
    )
    mountHook(() => mod.useSendMessage()) // populate capturedConfig
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    const cache = capturedQc.getQueryData<{ pages: { messages: Msg[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].ids).toEqual([])
    const overlay = stream.getMessageStreamState(capturedQc, { kind: "channel", id: "ch_1", serverId: "s1" })
    expect(overlay.outboxByNonce.size).toBe(0)
    expect(overlay.liveIds.length).toBe(1)
    expect(overlay.liveIds).toContain("server_id_1")
    expect(materializeMessageStream([], overlay, canonicalMessageReader(capturedQc)).find(row => row.id === "server_id_1")).toMatchObject({ seq: 9, authorId: "u_me", content: "canonical content", clientNonce: "n1" })
    expect(canonicalRegistry.collections.messages.get("server_id_1")).toMatchObject({ authorId: "u_me", content: "canonical content", embeds: [{ title: "Canonical embed" }] })
    expect(canonicalRegistry.collections.profiles.get("u_me")?.name).toBe("Canonical Name")
  })

  it("re-ranks a loaded participating forum thread from the canonical send timestamp", async () => {
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })
    const mod = await loadMod()
    await installCanonicalRegistry()
    await seedCanonicalSidebar()
    mountHook(() => mod.useSendMessage())

    await runMutation({
      serverId: "s1",
      channelId: "post_1",
      forumParentChannelId: "forum_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    expect((await canonicalSidebar()).threads[0])
      .toMatchObject({
        activityAt: "2026-08-07T10:00:00.000Z",
        expiresAt: "2026-08-10T10:00:00.000Z",
      })
  })

  it("invalidates the sidebar collection when a just-enrolled thread is not loaded", async () => {
    const sidebarKey = communityKeys.forumSidebarThreads("s1")
    capturedQc.setQueryData(sidebarKey, { ...sidebarData(), threads: [] })
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })
    const mod = await loadMod()
    await installCanonicalRegistry()
    await seedCanonicalParent("forum")
    mountHook(() => mod.useSendMessage())

    await runMutation({
      serverId: "s1",
      channelId: "post_new",
      forumParentChannelId: "forum_1",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    await vi.waitFor(() => {
      expect(capturedQc.getQueryState(sidebarKey)?.isInvalidated).toBe(true)
    })
  })

  it("does not touch forum resources when sending in an ordinary text thread", async () => {
    await seedParent("text", "text_parent")
    const baseKey = communityKeys.forumSidebarThreads("s1")
    const retainedKey = communityKeys.forumSidebarRetained("s1", "forum_post")
    const metaKey = communityKeys.channelMeta("s1", "text_thread")
    const hintKey = communityKeys.forumOpenerHint("s1", "forum_opener")
    capturedQc.setQueryData(baseKey, sidebarData())
    capturedQc.setQueryData(retainedKey, { id: "forum_post" })
    capturedQc.setQueryData(metaKey, { id: "text_thread", parentChannelId: "text_parent" })
    capturedQc.setQueryData(hintKey, { id: "forum_opener", content: "Forum title" })
    const before = [
      capturedQc.getQueryData(baseKey),
      capturedQc.getQueryData(retainedKey),
      capturedQc.getQueryData(metaKey),
      capturedQc.getQueryData(hintKey),
    ]
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_id_1", 9) })
    const mod = await loadMod()
    mountHook(() => mod.useSendMessage())

    await runMutation({
      serverId: "s1",
      channelId: "text_thread",
      forumParentChannelId: "text_parent",
      content: "hi",
      author: { id: "u_me", name: "me", avatar: "M" },
    })

    expect(capturedQc.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect([
      capturedQc.getQueryData(baseKey),
      capturedQc.getQueryData(retainedKey),
      capturedQc.getQueryData(metaKey),
      capturedQc.getQueryData(hintKey),
    ]).toEqual(before)
  })
})

describe("useSendMessage — rollback", () => {
  it("marks the optimistic row as failed on server error", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    const stream = await import("@/test/community-query-owner")
    canonicalRegistry.runtime.messageStream.actions.accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    mountHook(() => mod.useSendMessage())
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pages: { messages: { id: string; failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].ids).toEqual([])
    expect(stream.getMessageStreamState(capturedQc, { kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.status).toBe("failed")
  })
})

// Regression pin — the mount-time effect in <MessageList> gates self-send
// auto-scroll on `tail.authorId === viewerUserId`.
describe("useSendMessage — stamps authorId on optimistic row", () => {
  it("optimistic row carries the sender's authorId", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const stream = await import("@/test/community-query-owner")
    canonicalRegistry.runtime.messageStream.actions.accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      {
        nonce: "n1",
        tempId: "temp_n1",
        message: { type: "chat", content: "hi", authorId: "u_me" },
        localUploads: [],
      },
    )
    expect(stream.getMessageStreamState(capturedQc, { kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.message.authorId).toBe("u_me")
    expect(mod.useSendMessage).toBeTypeOf("function")
  })
})

// ── useSendDmMessage ──────────────────────────────────────────────────────

async function acceptDmIntent(nonce = "n1") {
  const stream = await import("@/test/community-query-owner")
  canonicalRegistry.runtime.messageStream.actions.accept(
    { kind: "dm", id: "dm_1" },
    {
      nonce,
      tempId: `temp_${nonce}`,
      message: { type: "chat", content: "hi", authorId: "u_me" },
      localUploads: [],
    },
  )
  return stream
}

describe("useSendDmMessage — overlay terminal emitter", () => {
  it("keeps Query base-only and emits exactly one postAck", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    apiFetchMock.mockResolvedValueOnce({ message: postedMessage("server_1", 8) })
    const mod = await loadMod()
    const stream = await acceptDmIntent()
    const dispatch = vi.spyOn(canonicalRegistry.runtime.messageStream.actions, "dispatch")
    mountHook(() => mod.useSendDmMessage())
    await runMutation({ dmId: "dm_1", content: "hi", nonce: "n1" })

    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      {
        type: "postAck",
        nonce: "n1",
        message: expect.objectContaining({
          id: "server_1",
          seq: 8,
          authorName: "Canonical Name",
          content: "canonical content",
          clientNonce: "n1",
        }),
      },
    )
  })

  it("keeps the accepted channel intent failed with one native terminal transition after runner rejection", async () => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    const runtime = canonicalRegistry.runtime
    runtime.messageStream.actions.accept(scope, { nonce: "runner_failure", tempId: "temp_runner_failure",
      message: { type: "chat", content: "keep optimistic", authorId: "u_me" }, localUploads: [] })
    const dispatch = vi.spyOn(runtime.messageStream.actions, "dispatch")
    apiFetchMock.mockRejectedValueOnce(new Error("send failed"))
    const mod = await loadMod()
    const mutation = mountHook(() => mod.useSendMessage())
    const { runAcceptedMessageIntent } = await import("@/components/community/messages/message-channel-controller-send")
    await act(async () => { await expect(runAcceptedMessageIntent({ runtime, messageScope: scope, nonce: "runner_failure",
      uploadFileAsync: vi.fn(), sendMessageAsync: mutation.mutateAsync,
      channelId: scope.id, serverId: scope.serverId, viewer: { id: "u_me", name: "Me", avatar: "M" },
    })).resolves.toBeUndefined() })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(runtime.messageStream.actions.getRetryPayload(scope, "runner_failure")?.message).toMatchObject({ content: "keep optimistic", failed: true })
    expect(dispatch.mock.calls).toEqual([[scope, { type: "postFail", nonce: "runner_failure" }]])
    expect(toastMock).toHaveBeenCalledExactlyOnceWith("send failed")
  })

  it("emits postFail for a generic network failure and leaves Query untouched", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    const stream = await acceptDmIntent()
    const dispatch = vi.spyOn(canonicalRegistry.runtime.messageStream.actions, "dispatch")
    mountHook(() => mod.useSendDmMessage())
    await runMutation({ dmId: "dm_1", content: "hi", nonce: "n1" }).catch(() => { })

    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(stream.getMessageStreamState(capturedQc, { kind: "dm", id: "dm_1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      { type: "postFail", nonce: "n1" },
    )
  })

  it("fails the upload intent when its view retires after upload succeeds, before native POST", async () => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }, runtime = canonicalRegistry.runtime
    const file = new File(["x"], "x.txt", { type: "text/plain" })
    runtime.messageStream.actions.accept(scope, { nonce: "upload-view", tempId: "temp-upload-view", message: { type: "chat", content: "file", authorId: "u_me" }, localUploads: [{ file, previewObjectUrl: "blob:view" }] })
    const dispatch = vi.spyOn(runtime.messageStream.actions, "dispatch"), mod = await loadMod(), mutation = mountHook(() => mod.useSendMessage())
    let current = true, finish!: (value: { id: string; filename: string; contentType: string; size: number }) => void
    const uploadFileAsync = vi.fn(() => new Promise<{ id: string; filename: string; contentType: string; size: number }>(resolve => { finish = resolve }))
    const assertActive = Object.assign(() => { if (!current) throw new DOMException("Retired view", "AbortError") }, { signal: new AbortController().signal })
    const { runAcceptedMessageIntent } = await import("@/components/community/messages/message-channel-controller-send")
    await act(async () => {
      const pending = runAcceptedMessageIntent({ runtime, messageScope: scope, nonce: "upload-view", assertActive, uploadFileAsync, sendMessageAsync: mutation.mutateAsync,
        channelId: scope.id, serverId: scope.serverId, viewer: { id: "u_me", name: "Me", avatar: "M" } })
      current = false
      finish({ id: "uploaded", filename: "x.txt", contentType: "text/plain", size: 1 })
      await pending
    })
    expect(uploadFileAsync).toHaveBeenCalledOnce()
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(dispatch.mock.calls).toEqual([[scope, { type: "uploadFailed", nonce: "upload-view" }]])
    expect(runtime.messageStream.actions.getRetryPayload(scope, "upload-view")?.message.failed).toBe(true)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it("fails the accepted channel intent once when its view retires before native POST starts", async () => {
    const scope = { kind: "channel" as const, id: "ch_1", serverId: "s1" }
    const runtime = canonicalRegistry.runtime
    runtime.messageStream.actions.accept(scope, { nonce: "retired_view", tempId: "temp_retired_view",
      message: { type: "chat", content: "keep optimistic", authorId: "u_me" }, localUploads: [] })
    const dispatch = vi.spyOn(runtime.messageStream.actions, "dispatch")
    const mod = await loadMod()
    const mutation = mountHook(() => mod.useSendMessage())
    let current = true
    const assertActive = Object.assign(() => { if (!current) throw new DOMException("Retired view", "AbortError") }, { signal: new AbortController().signal })
    const { runAcceptedMessageIntent } = await import("@/components/community/messages/message-channel-controller-send")
    await act(async () => {
      const pending = runAcceptedMessageIntent({ runtime, messageScope: scope, nonce: "retired_view", assertActive,
        uploadFileAsync: vi.fn(), sendMessageAsync: mutation.mutateAsync,
        channelId: scope.id, serverId: scope.serverId, viewer: { id: "u_me", name: "Me", avatar: "M" },
      })
      current = false
      await expect(pending).resolves.toBeUndefined()
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(dispatch.mock.calls).toEqual([[scope, { type: "postFail", nonce: "retired_view" }]])
    expect(runtime.messageStream.actions.getRetryPayload(scope, "retired_view")?.message).toMatchObject({ content: "keep optimistic", failed: true })
    expect(toastMock).not.toHaveBeenCalled()
  })
})

describe("useSendDmMessage — 403 blocked special-case", () => {
  it("removes the temp row and fires the scoped toast, no failed:true state", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    // Import ApiError AFTER loadMod so it resolves against the SAME module
    // instance the hook's `err instanceof ApiError` check will see.
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("blocked", 403))
    const stream = await acceptDmIntent()
    const dispatch = vi.spyOn(canonicalRegistry.runtime.messageStream.actions, "dispatch")
    mountHook(() => mod.useSendDmMessage())
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      nonce: "n1",
    }).catch(() => { })
    expect(stream.getMessageStreamState(capturedQc, { kind: "dm", id: "dm_1" }).outboxByNonce.size).toBe(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
      { kind: "dm", id: "dm_1" },
      { type: "terminalReject", nonce: "n1" },
    )
    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(toastMock).toHaveBeenCalledWith("You cannot send messages to this user")
  })

  it("regression: a generic 500 still marks the row failed and fires the generic send-failed toast (not the blocked toast)", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("boom", 500))
    const stream = await acceptDmIntent()
    mountHook(() => mod.useSendDmMessage())
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      nonce: "n1",
    }).catch(() => { })
    expect(stream.getMessageStreamState(capturedQc, { kind: "dm", id: "dm_1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    // Not the blocked-specific copy — any other error falls through to the
    // generic send-failed toast (see `useSendDmMessage`'s `onError` fallback).
    expect(toastMock).not.toHaveBeenCalledWith("You cannot send messages to this user")
    expect(toastMock).toHaveBeenCalledWith("boom")
  })
})

// 429 rate-limit toasts on both channel and DM send paths — the pill stays
// as `failed: true` so the retry affordance is still visible, but a toast
// fires so the user knows why the send didn't go through.
describe("useSendMessage — 429 rate limit fires a toast + marks failed", () => {
  it("channel 429: toast fires and row is marked failed:true", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("rate_limited", 429))
    mountHook(() => mod.useSendMessage())
    const stream = await import("@/test/community-query-owner")
    canonicalRegistry.runtime.messageStream.actions.accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].ids).toEqual([])
    expect(stream.getMessageStreamState(capturedQc, { kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Rate limited"))
  })
})

describe("useSendDmMessage — 429 rate limit fires a toast + marks failed", () => {
  it("DM 429: toast fires and row is marked failed:true (not scrubbed like 403 blocked)", async () => {
    capturedQc.setQueryData(communityKeys.dmMessages("dm_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("rate_limited", 429))
    const stream = await acceptDmIntent()
    mountHook(() => mod.useSendDmMessage())
    await runMutation({
      dmId: "dm_1",
      content: "hi",
      nonce: "n1",
    }).catch(() => { })
    expect(stream.getMessageStreamState(capturedQc, { kind: "dm", id: "dm_1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(capturedQc.getQueryData(communityKeys.dmMessages("dm_1"))).toEqual(makeCache([]))
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Rate limited"))
  })
})

// Regression guard — channel path stays generic-error, never fires the DM's
// specific blocked toast even on 403 (that shouldn't happen on channels;
// ensure the hook doesn't accidentally add DM's onBlocked branch to
// `useSendMessage`). It still falls through to the generic send-failed
// toast, same as any other non-429 error.
describe("useSendMessage — no blocked branch on channel path", () => {
  it("403 blocked on channel POST still marks failed:true and skips the DM-specific toast", async () => {
    capturedQc.setQueryData(communityKeys.channelMessages("ch_1"), makeCache([]))
    const mod = await loadMod()
    const { ApiError } = await import("@/lib/errors")
    apiFetchMock.mockRejectedValueOnce(new ApiError("blocked", 403))
    mountHook(() => mod.useSendMessage())
    const stream = await import("@/test/community-query-owner")
    canonicalRegistry.runtime.messageStream.actions.accept(
      { kind: "channel", id: "ch_1", serverId: "s1" },
      { nonce: "n1", tempId: "temp_n1", message: { type: "chat", content: "hi" }, localUploads: [] },
    )
    await runMutation({
      serverId: "s1",
      channelId: "ch_1",
      content: "hi",
      nonce: "n1",
      author: { id: "u_me", name: "me", avatar: "M" },
    }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pages: { messages: { failed?: boolean }[] }[] }>(
      communityKeys.channelMessages("ch_1"),
    )
    expect(cache?.pages[0].ids).toEqual([])
    expect(stream.getMessageStreamState(capturedQc, { kind: "channel", id: "ch_1", serverId: "s1" }).outboxByNonce.get("n1")?.status).toBe("failed")
    expect(toastMock).not.toHaveBeenCalledWith("You cannot send messages to this user")
    expect(toastMock).toHaveBeenCalledWith("blocked")
  })
})

// ── usePinMessage ─────────────────────────────────────────────────────────

describe("usePinMessage — invalidates pins on success", () => {
  it("triggers invalidateQueries on pins(channelId)", async () => {
    capturedQc.setQueryData(communityKeys.pins("ch_1"), { pins: [] })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mountHook(() => mod.usePinMessage())
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ channelId: "ch_1", messageId: "m_1" })
    expect(
      spy.mock.calls.some((c) => {
        const key = c[0]?.queryKey as unknown[] | undefined
        return Array.isArray(key) && key.includes("pins")
      }),
    ).toBe(true)
  })
})

// ── useUnpinMessage ───────────────────────────────────────────────────────

describe("useUnpinMessage — rollback", () => {
  it("removes optimistically and restores on failure", async () => {
    capturedQc.setQueryData(communityKeys.pins("ch_1"), { pins: [{ id: "m_1", content: "hi" }] })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mountHook(() => mod.useUnpinMessage())
    await runMutation({ channelId: "ch_1", messageId: "m_1" }).catch(() => { })
    const cache = capturedQc.getQueryData<{ pins: unknown[] }>(communityKeys.pins("ch_1"))
    expect(cache?.pins).toHaveLength(1)
  })
})

// ── useCreateThread ───────────────────────────────────────────────────────

describe("useCreateThread — patches parent message + invalidates threads", () => {
  it("adds thread indicator to the parent message with messageCount: 0", async () => {
    // Regression: previously patched messageCount=1 on the assumption that
    // the parent message was cloned into the thread. #6 removed the
    // parent-clone, so new threads start empty. `messageCount` MUST be 0
    // to avoid the UI showing "1 reply" on an empty thread.
    ingestMessages(canonicalRegistry, "ch_parent", [{ id: "m_p", type: "chat", content: "Opener" }])
    capturedQc.setQueryData(communityKeys.channelMessages("ch_parent"), makeCache([{ id: "m_p" }]))
    apiFetchMock.mockResolvedValueOnce({ id: "thr_1" })
    const mod = await loadMod()
    mountHook(() => mod.useCreateThread())
    await runMutation({ serverId: "s1", channelId: "ch_parent", messageId: "m_p", name: "Discussion" })
    expect(canonicalRegistry.collections.channels.get("thr_1")).toMatchObject({ parentMessageId: "m_p", name: "Discussion", messageCount: 0 })
    expect(capturedQc.getQueryData(communityKeys.channelMessages("ch_parent"))).toEqual(makeCache([{ id: "m_p" }]))
  })
})

// ── useMarkAllInboxRead ───────────────────────────────────────────────────

describe("useMarkAllInboxRead", () => {
  it("uses the three existing read-all endpoints", async () => {
    capturedQc.setQueryData(communityKeys.inboxUnreads(), { servers: [] })
    capturedQc.setQueryData(communityKeys.inboxMentions(), { mentions: [] })
    apiFetchMock.mockResolvedValue({ revision: 2 })
    const mod = await loadMod()
    mountHook(() => mod.useMarkAllInboxRead())
    await runMutation<void>(undefined as unknown as void)
    const posts = apiFetchMock.mock.calls.filter(
      (c) => (c[1] as { method?: string })?.method === "POST",
    )
    expect(posts.map((call) => call[0])).toEqual([
      "/api/community/users/me/inbox/mentions/read-all",
      "/api/community/users/me/inbox/unreads/read-all",
      "/api/community/users/me/inbox/dms/read-all",
    ])
  })

  it("clears the canonical attention owner optimistically without rewriting legacy raw caches", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot } = await import("@/lib/community-db/sync")
    ingestAttentionSnapshot(canonicalRegistry!, {
      scopes: [{
        scopeId: "ch_1", channelId: "ch_1", serverId: "s_1", parentChannelId: null,
        ordinaryUnread: true, lastUnreadSeq: 1, lastAttentionSeq: 1, attentionCount: 1,
      }],
      items: [{
        id: "mention:men_1", kind: "mention", sourceId: "men_1", scopeId: "ch_1",
        messageId: "m_1", actorUserId: "u_2", createdAt: "2026-09-27T00:00:00.000Z",
      }, {
        id: "friend_request:f_1", kind: "friend_request", sourceId: "f_1",
        scopeId: null, messageId: null, actorUserId: "u_3",
        createdAt: "2026-09-27T00:00:01.000Z",
      }],
      limit: 100,
      truncated: false,
    })
    capturedQc.setQueryData(communityKeys.inboxUnreads(), {
      servers: [{ serverId: "s_1", serverName: "s", channels: [{ channelId: "ch_1" }] }],
    })
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    mountHook(() => mod.useMarkAllInboxRead())
    let release!: (value: { revision: number }) => void
    apiFetchMock.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const pending = startMutation(undefined)
    await waitFor(() => expect(canonicalRegistry.collections.attentionScopes.get("ch_1")).toBeUndefined())
    expect(capturedQc.getQueryData(communityKeys.inboxUnreads())).toEqual({
      servers: [{ serverId: "s_1", serverName: "s", channels: [{ channelId: "ch_1" }] }],
    })
    expect(capturedQc.getQueryData(communityKeys.inboxMentions())).toEqual({
      mentions: [{ id: "men_1" }],
    })
    await vi.waitFor(() => {
      expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")).toBeUndefined()
      expect(canonicalRegistry!.collections.attentionItems.get("mention:men_1")).toBeUndefined()
      expect(canonicalRegistry!.collections.attentionItems.get("friend_request:f_1")).toBeDefined()
    })
    apiFetchMock.mockResolvedValue({ scopes: [], items: [], limit: 100, truncated: false })
    await act(async () => { release({ revision: 2 }); await pending })
  })

  it("reconciles the canonical attention and read-state snapshots after success", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/read-all")) {
        return { revision: 3 }
      }
      if (path === "/api/community/users/me/attention") {
        return { scopes: [], items: [], limit: 100, truncated: false }
      }
      if (path === "/api/community/users/me/read-state") {
        return { revision: 3, readStates: [] }
      }
      throw new Error(`unexpected path: ${path}`)
    })
    mountHook(() => mod.useMarkAllInboxRead())
    await runMutation<void>(undefined as unknown as void)
    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/attention",
        expect.objectContaining({ signal: expect.anything() }),
      )
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/read-state",
        expect.objectContaining({ signal: expect.anything() }),
      )
    })
  })

  it("preserves the failed mention domain when channel and DM mark-all succeed", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot } = await import("@/lib/community-db/sync")
    const mentionOnly = {
      scopes: [{
        scopeId: "ch_1", channelId: "ch_1", serverId: "s_1", parentChannelId: null,
        ordinaryUnread: false, lastUnreadSeq: 4, lastAttentionSeq: 4, attentionCount: 1,
      }],
      items: [{
        id: "mention:men_1", kind: "mention" as const, sourceId: "men_1", scopeId: "ch_1",
        messageId: "m_1", actorUserId: "u_2", createdAt: "2026-09-27T00:00:00.000Z",
      }],
      limit: 100,
      truncated: false,
    }
    ingestAttentionSnapshot(canonicalRegistry!, {
      ...mentionOnly,
      scopes: [{ ...mentionOnly.scopes[0]!, ordinaryUnread: true }],
    })
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/community/users/me/inbox/mentions/read-all") throw new Error("mentions failed")
      if (path.endsWith("/read-all")) return { revision: 5 }
      if (path === "/api/community/users/me/attention") return mentionOnly
      if (path === "/api/community/users/me/read-state") return { revision: 5, readStates: [] }
      throw new Error(`unexpected path: ${path}`)
    })
    mountHook(() => mod.useMarkAllInboxRead())

    await runMutation<void>(undefined as unknown as void)

    await vi.waitFor(() => {
      expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")).toMatchObject({
        ordinaryUnread: false,
        attentionCount: 1,
        lastAttentionSeq: 4,
      })
      expect(canonicalRegistry!.collections.attentionItems.get("mention:men_1")).toBeDefined()
    })
  })

  it("toasts the failure reason when all three read-all requests fail", async () => {
    apiFetchMock.mockRejectedValue(new Error("boom"))
    const mod = await loadMod()
    mountHook(() => mod.useMarkAllInboxRead())
    await runMutation<void>(undefined as unknown as void).catch(() => { })
    expect(toastMock).toHaveBeenCalledWith("boom")
  })

  it("restores canonical attention when the atomic read-all request fails", async () => {
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot } = await import("@/lib/community-db/sync")
    ingestAttentionSnapshot(canonicalRegistry!, {
      scopes: [{
        scopeId: "channel", channelId: "channel", serverId: "s_1", parentChannelId: null,
        ordinaryUnread: true, lastUnreadSeq: 1, lastAttentionSeq: null, attentionCount: 0,
      }],
      items: [],
      limit: 100,
      truncated: false,
    })
    apiFetchMock.mockRejectedValue(new Error("account read-all failed"))
    const mod = await loadMod()
    mountHook(() => mod.useMarkAllInboxRead())

    await expect(runMutation<void>(undefined as unknown as void))
      .rejects.toThrow("account read-all failed")

    expect(canonicalRegistry!.collections.attentionScopes.get("channel")).toBeDefined()
    expect(toastMock).toHaveBeenCalledWith("account read-all failed")
  })

  it("reconciles mark-all after an intervening canonical event declines rollback", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot, ingestMessages, projectCommunityWsEventToDb } = await import(
      "@/lib/community-db/sync"
    )
    const canonical = {
      scopes: [{
        scopeId: "channel", channelId: "channel", serverId: "s_1", parentChannelId: null,
        ordinaryUnread: true, lastUnreadSeq: 1, lastAttentionSeq: null, attentionCount: 0,
      }],
      items: [],
      limit: 100,
      truncated: false,
      included: attentionIncluded(),
    }
    ingestAttentionSnapshot(canonicalRegistry!, canonical)
    let fail!: (error: Error) => void
    const held = new Promise((_, reject) => { fail = reject })
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/community/users/me/attention") return canonical
      if (path.endsWith("/read-all")) return held
      if (path.endsWith("/read-state")) return { revision: 1, readStates: [] }
      throw new Error("unexpected " + path)
    })
    mountHook(() => mod.useMarkAllInboxRead())
    const pending = startMutation(undefined)
    await waitFor(() => expect(canonicalRegistry.collections.attentionScopes.get("channel")).toBeUndefined())
    ingestMessages(canonicalRegistry!, "other", [{ id: "event", type: "chat", content: "old" }])
    projectCommunityWsEventToDb(capturedQc, {
      type: "community:message.edited",
      channelId: "other",
      messageId: "event",
      content: "new",
    } as never)

    await act(async () => { fail(new Error("account read-all failed")); await pending })

    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/attention",
        expect.objectContaining({ signal: expect.anything() }),
      )
      expect(canonicalRegistry!.collections.attentionScopes.get("channel")).toBeDefined()
    })
  })

  it("rejects an action after its canonical owner retires without IO or visible effects", async () => {
    const mod = await loadMod()
    mountHook(() => mod.useMarkAllInboxRead())
    canonicalRegistry.runtime.lifecycle.setState((state) => ({ ...state, active: false, generation: state.generation + 1 }))
    await expect(runMutation(undefined)).rejects.toMatchObject({ name: "AbortError" })
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it("retries the same existing domain mutations after a transient failure", async () => {
    let attempts = 0
    apiFetchMock.mockImplementation(async () => {
      if (attempts++ === 0) {
        throw new Error("account read-all failed")
      }
      return { revision: 2 }
    })
    const mod = await loadMod()
    mountHook(() => mod.useMarkAllInboxRead())

    await runMutation<void>(undefined as unknown as void).catch(() => { })
    await runMutation<void>(undefined as unknown as void)

    expect(apiFetchMock.mock.calls.filter(
      (call) => String(call[0]).endsWith("/read-all"),
    )).toHaveLength(6)
    expect(toastMock).toHaveBeenCalledWith("account read-all failed")
  })
})

// ── useDeleteMention — rollback ──────────────────────────────────────────

describe("useDeleteMention — rollback", () => {
  it("commits canonical attention removal and reconciles after success", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot } = await import("@/lib/community-db/sync")
    const canonical = {
      scopes: [{
        scopeId: "ch_1", channelId: "ch_1", serverId: "s_1", parentChannelId: null,
        ordinaryUnread: false, lastUnreadSeq: 4, lastAttentionSeq: 4, attentionCount: 1,
      }],
      items: [{
        id: "mention:men_1", kind: "mention" as const, sourceId: "men_1", scopeId: "ch_1",
        messageId: "m_1", actorUserId: "u_2", createdAt: "2026-09-27T00:00:00.000Z",
      }],
      limit: 100,
      truncated: false,
      included: attentionIncluded({
        profiles: [{
          userId: "u_2", name: "Two", discriminator: "0002", avatar: "T", avatarVersion: 1,
        }],
        messages: [{
          id: "m_1", channelId: "ch_1", authorId: "u_2", content: "hello",
          createdAt: "2026-09-27T00:00:00.000Z", seq: 4, type: "chat",
        }],
      }),
    }
    ingestAttentionSnapshot(canonicalRegistry!, canonical)
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1", channelId: "ch_1", kind: "mention", m: { id: "m_1", seq: 4 } }],
    })
    apiFetchMock.mockImplementation(async (path: string) => (
      path === "/api/community/users/me/attention"
        ? { ...canonical, scopes: [], items: [] }
        : { revision: 5 }
    ))

    mountHook(() => mod.useDeleteMention())
    await runMutation({ mentionId: "men_1" })

    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/attention",
        expect.objectContaining({ signal: expect.anything() }),
      )
    })
  })

  it("reconciles a failed dismissal after an intervening canonical event", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot, ingestMessages, projectCommunityWsEventToDb } = await import(
      "@/lib/community-db/sync"
    )
    const canonical = {
      scopes: [{
        scopeId: "ch_1", channelId: "ch_1", serverId: "s_1", parentChannelId: null,
        ordinaryUnread: false, lastUnreadSeq: 4, lastAttentionSeq: 4, attentionCount: 1,
      }],
      items: [{
        id: "mention:men_1", kind: "mention" as const, sourceId: "men_1", scopeId: "ch_1",
        messageId: "m_1", actorUserId: "u_2", createdAt: "2026-09-27T00:00:00.000Z",
      }],
      limit: 100,
      truncated: false,
      included: attentionIncluded({
        profiles: [{
          userId: "u_2", name: "Two", discriminator: "0002", avatar: "T", avatarVersion: 1,
        }],
        messages: [{
          id: "m_1", channelId: "ch_1", authorId: "u_2", content: "hello",
          createdAt: "2026-09-27T00:00:00.000Z", seq: 4, type: "chat",
        }],
      }),
    }
    ingestAttentionSnapshot(canonicalRegistry!, canonical)
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1", channelId: "ch_1", kind: "mention", m: { id: "m_1", seq: 4 } }],
    })
    let fail!: (error: Error) => void
    const held = new Promise((_, reject) => { fail = reject })
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/api/community/users/me/attention") return canonical
      if (path.includes("/inbox/mentions/")) return held
      throw new Error("unexpected " + path)
    })
    mountHook(() => mod.useDeleteMention())
    const pending = startMutation({ mentionId: "men_1" })
    await waitFor(() => expect(canonicalRegistry.collections.attentionItems.get("mention:men_1")).toBeUndefined())
    ingestMessages(canonicalRegistry!, "other", [{ id: "event", type: "chat", content: "old" }])
    projectCommunityWsEventToDb(capturedQc, {
      type: "community:message.edited",
      channelId: "other",
      messageId: "event",
      content: "new",
    } as never)

    await act(async () => { fail(new Error("dismiss failed")); await pending })

    await vi.waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/community/users/me/attention",
        expect.objectContaining({ signal: expect.anything() }),
      )
      expect(canonicalRegistry!.collections.attentionItems.get("mention:men_1")).toBeDefined()
    })
  })

  it("keeps a same-seq sibling and only decrements badges for direct mentions", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const reply = {
      id: "reply-1",
      kind: "reply",
      channelId: "ch_1",
      m: { id: "msg_1", seq: 4 },
    }
    const mention = {
      id: "mention-1",
      kind: "mention",
      channelId: "ch_1",
      m: { id: "msg_1", seq: 4 },
    }
    const { ingestAttentionSnapshot, ingestMessages } = await import(
      "@/lib/community-db/sync"
    )
    ingestMessages(canonicalRegistry!, "ch_1", [{
      id: "msg_1", type: "chat", authorId: "u_2", seq: 4,
    }])
    ingestAttentionSnapshot(canonicalRegistry!, {
      scopes: [{
        scopeId: "ch_1", channelId: "ch_1", serverId: "srv_1", parentChannelId: null,
        ordinaryUnread: false, lastUnreadSeq: 4, lastAttentionSeq: 4, attentionCount: 2,
      }],
      items: [reply, mention].map((row) => ({
        id: `mention:${row.id}`,
        kind: row.kind as "mention" | "reply",
        sourceId: row.id,
        scopeId: "ch_1",
        messageId: "msg_1",
        actorUserId: "u_2",
        createdAt: "2026-09-27T00:00:00.000Z",
      })),
      limit: 100,
      truncated: false,
    })
    const { getActiveAccountUnreadProjection } = await import(
      "@/hooks/community/account-unread-projection"
    )
    const projection = getActiveAccountUnreadProjection(capturedQc)
    projection.setNotificationPolicy({})
    for (const attentionId of [reply.id, mention.id]) {
      projection.recordArrival({
        channelId: "ch_1",
        serverId: "srv_1",
        messageId: "msg_1",
        attentionId,
        seq: 4,
        isMention: true,
      })
    }
    mountHook(() => mod.useDeleteMention())
    let fail!: (error: Error) => void
    apiFetchMock.mockImplementation((path: string) => path === "/api/community/users/me/attention"
      ? new Promise(() => {})
      : new Promise((_, reject) => { fail = reject }))
    const cachedAttentionItems = () => Array.from(canonicalRegistry.collections.attentionItems.values())
    const cachedAttentionCount = () => canonicalRegistry.collections.attentionScopes.get("ch_1")?.attentionCount
    const baseItems = capturedQc.getQueryData(communityKeys.communityDbCollection(canonicalRegistry.scopeId, "attentionItems"))

    const replyPending = startMutation({ mentionId: reply.id })
    await waitFor(() => expect(canonicalRegistry.collections.attentionItems.get("mention:reply-1")).toBeUndefined())
    expect(capturedQc.getQueryData(communityKeys.communityDbCollection(canonicalRegistry.scopeId, "attentionItems"))).toBe(baseItems)
    expect(cachedAttentionItems().map((item) => item.id)).toEqual(["mention:mention-1"])
    expect(cachedAttentionCount()).toBe(1)
    await vi.waitFor(() => {
      expect(canonicalRegistry!.collections.attentionItems.get("mention:reply-1")).toBeUndefined()
      expect(canonicalRegistry!.collections.attentionItems.get("mention:mention-1")).toBeDefined()
      expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")?.attentionCount).toBe(1)
    })
    expect(projection.projectUnread(
      "inbox-mentions", "ch_1", true, 4, "mentions", null, true, mention.id,
    )).toBe(true)
    expect(projection.projectServerMentionCount("srv_1", [{
      channelId: "ch_1", count: 1, lastSeq: 4,
    }])).toBe(1)

    await act(async () => { fail(new Error("retry direct")); await replyPending })
    expect(cachedAttentionItems().map((item) => item.id).sort()).toEqual([
      "mention:mention-1", "mention:reply-1",
    ])
    expect(cachedAttentionCount()).toBe(2)
    const mentionPending = startMutation({ mentionId: mention.id })
    await waitFor(() => expect(canonicalRegistry.collections.attentionItems.get("mention:mention-1")).toBeUndefined())
    expect(cachedAttentionItems().map((item) => item.id)).toEqual(["mention:reply-1"])
    expect(cachedAttentionCount()).toBe(1)
    await vi.waitFor(() => {
      expect(canonicalRegistry!.collections.attentionItems.get("mention:mention-1")).toBeUndefined()
      expect(canonicalRegistry!.collections.attentionItems.get("mention:reply-1")).toBeDefined()
      expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")?.attentionCount).toBe(1)
    })
    expect(projection.projectUnread(
      "inbox-mentions", "ch_1", true, 4, "mentions", null, true, reply.id,
    )).toBe(true)
    expect(projection.projectServerMentionCount("srv_1", [{
      channelId: "ch_1", count: 1, lastSeq: 4,
    }])).toBe(0)
    await act(async () => { fail(new Error("cleanup")); await mentionPending })
    expect(cachedAttentionItems().map((item) => item.id).sort()).toEqual([
      "mention:mention-1", "mention:reply-1",
    ])
    expect(cachedAttentionCount()).toBe(2)
    await vi.waitFor(() => {
      expect(canonicalRegistry!.collections.attentionItems.get("mention:reply-1")).toBeDefined()
      expect(canonicalRegistry!.collections.attentionItems.get("mention:mention-1")).toBeDefined()
      expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")?.attentionCount).toBe(2)
    })
  })

  it("hides only the exact attention facet and restores it on failure", async () => {
    const mod = await loadMod()
    await installCanonicalRegistry()
    const { ingestAttentionSnapshot, ingestMessages } = await import(
      "@/lib/community-db/sync"
    )
    ingestMessages(canonicalRegistry!, "ch_1", [{
      id: "msg_1", type: "chat", authorId: "u_2", seq: 4,
    }])
    ingestAttentionSnapshot(canonicalRegistry!, {
      scopes: [{
        scopeId: "ch_1", channelId: "ch_1", serverId: "srv_1", parentChannelId: null,
        ordinaryUnread: true, lastUnreadSeq: 4, lastAttentionSeq: 4, attentionCount: 1,
      }],
      items: [{
        id: "mention:men_1", kind: "mention", sourceId: "men_1", scopeId: "ch_1",
        messageId: "msg_1", actorUserId: "u_2", createdAt: "2026-09-27T00:00:00.000Z",
      }],
      limit: 100,
      truncated: false,
    })
    const { getActiveAccountUnreadProjection } = await import(
      "@/hooks/community/account-unread-projection"
    )
    const projection = getActiveAccountUnreadProjection(capturedQc)
    projection.recordArrival({
      channelId: "ch_1",
      serverId: "srv_1",
      messageId: "msg_1",
      attentionId: "men_1",
      seq: 4,
      isMention: true,
    })
    mountHook(() => mod.useDeleteMention())
    let fail!: (error: Error) => void
    apiFetchMock.mockImplementation((path: string) => path === "/api/community/users/me/attention"
      ? new Promise(() => {})
      : new Promise((_, reject) => { fail = reject }))
    const pending = startMutation({ mentionId: "men_1" })
    await waitFor(() => expect(canonicalRegistry.collections.attentionItems.get("mention:men_1")).toBeUndefined())
    expect(canonicalRegistry!.collections.attentionItems.get("mention:men_1")).toBeUndefined()
    expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")).toMatchObject({
      ordinaryUnread: true,
      attentionCount: 0,
    })
    expect(projection.projectUnread("inbox-unreads", "ch_1", false)).toBe(true)
    expect(projection.projectUnread("inbox-mentions", "ch_1", false)).toBe(false)

    await act(async () => { fail(new Error("boom")); await pending })
    expect(canonicalRegistry!.collections.attentionItems.get("mention:men_1")).toBeDefined()
    expect(canonicalRegistry!.collections.attentionScopes.get("ch_1")?.attentionCount).toBe(1)
    expect(projection.projectUnread("inbox-mentions", "ch_1", false)).toBe(true)
  })

  it("restores mention on failure", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mountHook(() => mod.useDeleteMention())
    await runMutation({ mentionId: "men_1" }).catch(() => { })
    const cache = capturedQc.getQueryData<{ mentions: { id: string }[] }>(
      communityKeys.inboxMentions(),
    )
    expect(cache?.mentions).toHaveLength(1)
  })

  it("toasts the failure reason on delete failure", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("boom"))
    const mod = await loadMod()
    mountHook(() => mod.useDeleteMention())
    await runMutation({ mentionId: "men_1" }).catch(() => { })
    expect(toastMock).toHaveBeenCalledWith("boom")
  })

  it("invalidates communityKeys.servers() on success so the rail badge decrements", async () => {
    capturedQc.setQueryData(communityKeys.inboxMentions(), {
      mentions: [{ id: "men_1" }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)
    const mod = await loadMod()
    mountHook(() => mod.useDeleteMention())
    const spy = vi.spyOn(capturedQc, "invalidateQueries")
    await runMutation({ mentionId: "men_1" })
    const serversInvalidates = spy.mock.calls.filter((c) => {
      const key = c[0]?.queryKey as unknown[] | undefined
      return Array.isArray(key) && key.length === 2 && key[0] === "community" && key[1] === "servers"
    })
    expect(serversInvalidates).toHaveLength(1)
  })
})
