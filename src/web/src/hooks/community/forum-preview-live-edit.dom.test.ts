import { createElement, type PropsWithChildren } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { dispatchCommunityWsEvent } from "./community-ws/registry"
import { captureCommunityLiveSnapshotToken, publishCommunityForumFeed, publishCommunityMessages, publishCommunityMessageFields } from "@/lib/community-db/sync"
import { normalizeThreadResources } from "./forum-feed-window"
import { forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions, publishConversationEntry } from "@/lib/community/conversation-entry"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch }))
vi.mock("./use-channel-panels", () => ({
  useForumTags: () => ({ data: { tags: [] }, isSuccess: true }),
}))
import { useForumFeed } from "./use-forum-feed"
import { useEditMessage } from "./mutations/messages"

const original = "original first body ".repeat(34)
const edited = "edited first body with complete content ".repeat(29)
const date = "2026-10-01T00:00:00.000Z"

function channel(id: string, type: "forum" | "thread", parentMessageId: string | null = null) {
  return { id, type, serverId: "server", categoryId: null, name: id, topic: "",
    parentChannelId: type === "thread" ? "forum" : null, parentMessageId, creatorId: "author",
    position: 0, archived: false, createdAt: date, lastMessageAt: date, messageCount: 2 }
}
function message(id: string, channelId: string, seq: number, content: string) {
  return { id, channelId, seq, content, authorId: "author", authorName: "Ada",
    authorAvatar: "A", authorAvatarVersion: 0, createdAt: date, type: "chat" as const,
    replyToId: null, clientNonce: null, attachments: [] }
}
function page(contractVersion: 2 | 3, firstSeq = 1) {
  return { contractVersion, channelId: "forum", channel: channel("forum", "forum"),
    threads: [channel("post", "thread", "title"), channel("other", "thread", "other-title")],
    included: { messages: [
      message("title", "forum", 104, "Original title"),
      message("first", "post", firstSeq, original),
      message("other-title", "forum", 105, "Other title"),
      message("other-first", "other", 1, "Other original"),
    ], members: [], profiles: [], tags: [], participantCounts: [] },
    page: { hasMore: false, nextCursor: null } }
}
async function mount(contractVersion: 2 | 3 = 2, firstSeq = 1) {
  const owner = await createCommunityQueryOwner()
  apiFetch.mockReset()
  apiFetch.mockResolvedValue(page(contractVersion, firstSeq))
  const entry = forumConversationEntryFixture("forum", "server", true)
  const target = { channelId: "forum", serverId: "server" }
  owner.client.setQueryData(conversationEntryOptions(owner.client, target).queryKey, publishConversationEntry(owner.client, target, entry, { token: captureCommunityLiveSnapshotToken(owner.client, "forum") }))
  owner.client.setQueryData(communityKeys.forumFeed("forum", null), data => data, { updatedAt: 1 })
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry }, children)
  }
  const view = renderHook(() => ({ ...useForumFeed("server", "forum"), editCommand: useEditMessage() }), { wrapper: Wrapper })
  await waitFor(() => expect(view.result.current.posts.find((post) => post.id === "post")?.preview).toBe(original))
  const context = { contract: contractVersion, deliveryMode: "single" as const,
    queryClient: owner.client, communityStore: owner.runtime.ui, wsStore: owner.runtime.ws,
    sub: { channelId: "forum" }, viewerUserIdRef: { current: "viewer" },
    matchesFocus: () => false, scheduleInboxInvalidate: vi.fn() }
  function edit(channelId: string, messageId: string, content: string, title = false) {
    act(() => dispatchCommunityWsEvent({ type: "community:message.edited", serverId: "server",
      channelId, messageId, content, ...(title ? { parentChannelId: "forum" } : {}) }, context))
  }
  return { ...owner, ...view, edit, preview: (id = "post") => view.result.current.posts.find((post) => post.id === id)?.preview }
}

describe("Forum first body through the actual edited dispatcher", () => {
  it("keeps the same forum window and confirms its exact first-body preview after HTTP edit without self WS", async () => {
    const view = await mount(3, 7)
    const key = communityKeys.forumFeed("forum", null)
    const window = view.client.getQueryData(key)
    let resolve!: (value: unknown) => void
    let command!: Promise<unknown>
    apiFetch.mockImplementation((_path: string, options?: { method?: string }) => options?.method === "PATCH"
      ? new Promise(done => { resolve = done })
      : Promise.resolve(page(3, 7)))
    try {
      expect(view.registry.collections.channels.get("post")?.firstMessageId).toBe("first")
      expect(view.registry.collections.messages.get("first")?.seq).toBe(7)
      act(() => { command = view.result.current.editCommand.mutateAsync({ serverId: "server", channelId: "post", messageId: "first", content: edited }) })
      await waitFor(() => expect(resolve).toBeTypeOf("function"))
      expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
      await waitFor(() => expect(view.preview()).toBe(edited))
      expect(view.client.getQueryData(key)).toBe(window)
      await act(async () => { resolve(undefined); await command })
      expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
      expect(view.client.getQueryData(key)).toBe(window)
      expect(view.preview("other")).toBe("Other original")
      expect(apiFetch.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(1)
      expect(view.preview()).toBe(edited)
    } finally {
      resolve?.(undefined)
      await command?.catch(() => undefined)
      view.unmount()
    }
  })

  it.each(["rollback", "WS then success", "WS then failure"] as const)("keeps first-body preview under the original edit transaction: %s", async outcome => {
    const view = await mount(3, 7)
    const key = communityKeys.forumFeed("forum", null), window = view.client.getQueryData(key)
    let resolve!: (value: unknown) => void, reject!: (reason: Error) => void
    apiFetch.mockImplementation((_path: string, options?: { method?: string }) => options?.method === "PATCH"
      ? new Promise((done, fail) => { resolve = done; reject = fail }) : Promise.resolve(page(3, 7)))
    let command!: Promise<unknown>
    try {
      act(() => { command = view.result.current.editCommand.mutateAsync({ serverId: "server", channelId: "post", messageId: "first", content: edited }).catch(error => error) })
      await waitFor(() => expect(resolve).toBeTypeOf("function"))
      await waitFor(() => expect(view.preview()).toBe(edited))
      if (outcome !== "rollback") view.edit("post", "first", "newer WS content")
      await act(async () => { if (outcome === "WS then success") resolve(undefined); else reject(new Error("edit denied")); await command })
      const expected = outcome === "rollback" ? original : "newer WS content"
      await waitFor(() => expect(view.preview()).toBe(expected))
      expect(view.registry.collections.messages.get("first")?.content).toBe(expected)
      expect(view.preview("other")).toBe("Other original")
      expect(view.client.getQueryData(key)).toBe(window)
    } finally { resolve?.(undefined); await command?.catch(() => undefined); view.unmount() }
  })

  it("does not mirror rejected content when another HTTP field is accepted", async () => {
    const view = await mount(3, 7)
    try {
      const token = captureCommunityLiveSnapshotToken(view.client, "post")
      view.edit("post", "first", "newer WS content")
      let published = false
      act(() => { published = publishCommunityMessageFields(view.client, "first", { content: "old HTTP content", authorName: "HTTP author" }, { token }) })
      expect(published).toBe(true)
      expect(view.registry.collections.messages.get("first")?.authorName).toBe("HTTP author")
      expect(view.registry.collections.messages.get("first")?.content).toBe("newer WS content")
      await waitFor(() => expect(view.preview()).toBe("newer WS content"))
    } finally { view.unmount() }
  })

  it.each([{ contract: 2 as const, firstSeq: 1 }, { contract: 3 as const, firstSeq: 7 }])(
    "updates the existing full preview from contract$contract first-body identity, not a sequence guess",
    async ({ contract, firstSeq }) => {
      const view = await mount(contract, firstSeq)
      view.edit("post", "first", edited)
      expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
      await waitFor(() => expect(view.preview()).toBe(edited))
      expect(view.result.current.posts.find((post) => post.id === "post")?.parent.text).toBe(edited)
      expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
      expect(apiFetch).toHaveBeenCalledTimes(1)
    },
  )

  it("keeps later reply and title edits out of the first-body preview", async () => {
    const view = await mount()
    act(() => publishCommunityMessages(view.client, { channelId: "post",
      messages: [message("later-reply", "post", 2, "Original later reply")],
      proof: { token: captureCommunityLiveSnapshotToken(view.client, "post"), signal: undefined } }))
    view.edit("post", "later-reply", "later reply edit")
    expect(view.registry.collections.messages.get("later-reply")?.content).toBe("later reply edit")
    view.edit("post", "title", "New title", true)
    await waitFor(() => expect(view.result.current.posts.find((post) => post.id === "post")?.name).toBe("New title"))
    expect(view.preview()).toBe(original)
    expect(view.preview("other")).toBe("Other original")
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("updates another post only through that post's known first body", async () => {
    const view = await mount()
    view.edit("other", "other-first", edited)
    expect(view.registry.collections.messages.get("other-first")?.content).toBe(edited)
    await waitFor(() => expect(view.preview("other")).toBe(edited))
    expect(view.preview()).toBe(original)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it("retains an edited preview over the original older HTTP feed", async () => {
    const view = await mount()
    const token = captureCommunityLiveSnapshotToken(view.client, "forum")
    view.edit("post", "first", edited)
    expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
    act(() => publishCommunityForumFeed(view.client, "forum",
      normalizeThreadResources("forum", page(2)), { token, signal: undefined }))
    await waitFor(() => expect(view.preview()).toBe(edited))
    expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
  })

  it("rejects an old account response before it can rewrite preview ownership", async () => {
    const view = await mount()
    view.runtime.ws.actions.activateProfileAccount("old-account")
    const token = captureCommunityLiveSnapshotToken(view.client, "forum")
    view.runtime.ws.actions.activateProfileAccount("new-account")
    expect(() => publishCommunityForumFeed(view.client, "forum",
      normalizeThreadResources("forum", page(2)), { token, signal: undefined }))
      .toThrow(expect.objectContaining({ name: "AbortError" }))
    expect(view.preview()).toBe(original)
  })

  it("does not invent first-body identity from an unaddressed legacy preview", async () => {
    const view = await mount()
    act(() => publishCommunityForumFeed(view.client, "forum", normalizeThreadResources("forum", {
      serverId: "server", parentType: "forum", threads: [
        { id: "post", name: "Original title", creatorId: "author", parentMessageId: "title",
          messageCount: 2, createdAt: date, lastMessageAt: date, activityAt: date },
      ], included: { parentMessages: [{ ...message("title", "forum", 104, "Original title"), authorImage: null }],
        firstMessages: [{ channelId: "post", content: original }], tags: [], participants: [] },
      hasMore: false,
    }), { token: captureCommunityLiveSnapshotToken(view.client, "forum"), signal: undefined }))
    view.edit("post", "first", edited)
    expect(view.registry.collections.messages.get("first")?.content).toBe(edited)
    expect(view.preview()).toBe(original)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })
})
