import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { MessageList } from "@/components/community/messages/message-list"
import { resolveMessageReadProjection } from "@/lib/community/message-read-projection"
import { useDmMessages, useMessages } from "./use-messages"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, scrollFixture } from "@/test/message-scroll-fixture"

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
beforeEach(() => { installMessageScrollFixture(); load.mockReset() })
afterEach(restoreMessageScrollFixture)
const kinds = ["text", "text-thread", "forum-post", "dm"] as const

it.each(kinds.flatMap(kind => [
  { takeover: true, repairFailure: false }, { takeover: false, repairFailure: false }, { takeover: true, repairFailure: true },
].map(mode => ({ kind, ...mode }))))(
  "preserves the actual $kind reader through Retry recovery with takeover=$takeover, repairFailure=$repairFailure",
  async ({ kind, takeover, repairFailure }) => {
    scrollFixture.width = 1280
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
    if (kind === "text-thread" || kind === "forum-post") {
      packet.channel = { ...packet.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      packet.parent = { ...packet.channel, id: "parent", type: kind === "forum-post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
      packet.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    const rows = Array.from({ length: 80 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
    packet.messages = rows.slice(0, 35)
    packet.readState = { ...packet.readState, lastReadMessageId: "m10", lastReadSeq: 10 }
    packet.selection = { reason: "read_pointer", anchorMessageId: "m10" }
    packet.page = { olderCursor: null, newerCursor: `${rows[34].createdAt}|m35`, hasMoreOlder: false, hasMoreNewer: true, latestSeq: 80 }
    await seedConversationEntry(owner.client, packet)
    const read = { ...packet.readState, lastReadMessageId: "m60", lastReadSeq: 60, lastReadAt: rows[59].createdAt }
    ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read] })
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    let reject!: (reason: Error) => void
    load.mockReturnValue(new Promise((_, no) => { reject = no }))
    let feed!: ReturnType<typeof useMessages>
    function Probe() {
      const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
      const dm = useDmMessages(kind === "dm" ? "c1" : null)
      feed = kind === "dm" ? dm : channel
      const projection = resolveMessageReadProjection({ messages: feed.messages, lastReadMessageId: feed.readSnapshot?.lastReadMessageId ?? null,
        viewerUserId: "viewer", anchorReconciled: feed.anchorReconciled })
      return <MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
        loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
        initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
        positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
        newDividerBefore={projection.newDividerBefore} hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
        onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      const root = view.getByTestId("community-message-scroller")
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      await act(async () => { reject(new Error("held entry failed")); await vi.advanceTimersByTimeAsync(2000) })
      resize()
      let release!: (value: typeof packet) => void
      const retry = new Promise<typeof packet>(resolve => { release = resolve })
      const repairPage = { ...packet.page, profiles: packet.profiles, messages: packet.messages }
      let failRepair = repairFailure
      load.mockImplementation((url: string) => url.includes("entry=1") ? retry
        : failRepair ? Promise.reject(new Error("owned window repair failed")) : Promise.resolve(repairPage))
      fireEvent.click(view.getByRole("button", { name: "Retry" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      if (takeover) {
        fireEvent.wheel(root, { deltaY: -300 })
        act(() => root.scrollTo({ top: root.scrollTop - 300 }))
        resize()
      }
      const viewport = root.getBoundingClientRect()
      const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(row => row.getBoundingClientRect().bottom > viewport.top + 1)!
      const readerId = reader.dataset.msgId!
      const offset = reader.getBoundingClientRect().top - viewport.top
      expect(Number(readerId.slice(1))).toBeLessThan(35)
      const fresh = { ...packet, messages: rows.slice(34), readState: read, readStateRevision: 5,
        selection: { reason: "read_pointer" as const, anchorMessageId: "m60" },
        page: { olderCursor: `${rows[34].createdAt}|m35`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
      await act(async () => { release(fresh); await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(root).toHaveAttribute("aria-busy", "false")
      if (repairFailure) expect(view.getByRole("alert")).toHaveTextContent("Couldn’t load the requested messages")
      else expect(view.queryByRole("alert")).toBeNull()
      if (takeover) {
        expect(feed.messages.map(row => row.id)).toContain(readerId)
        expect(root.querySelector(`[data-msg-id="${readerId}"]`)).toBe(reader)
        expect(Math.abs(reader.getBoundingClientRect().top - root.getBoundingClientRect().top - offset)).toBeLessThanOrEqual(1)
      } else {
        expect(feed.messages.map(row => row.id)).toEqual(rows.slice(34).map(row => row.id))
        const divider = root.querySelector<HTMLElement>("[data-new-divider]")!.getBoundingClientRect()
        expect(divider.bottom).toBeGreaterThan(viewport.top)
        expect(divider.top).toBeLessThan(viewport.bottom)
      }
      if (repairFailure) {
        expect(root).toHaveAttribute("data-pagination-enabled", "false")
        expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
        fireEvent.click(view.getByRole("button", { name: "Retry" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.getByRole("alert")).toHaveTextContent("Couldn’t load the requested messages")
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(feed.messages.map(row => row.id)).toContain(readerId)
        failRepair = false
        fireEvent.click(view.getByRole("button", { name: "Retry" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.queryByRole("alert")).toBeNull()
        expect(view.getByTestId("community-message-scroller")).toBe(root)
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(feed.messages.map(row => row.id)).toEqual(rows.map(row => row.id))
      }
      expect(feed.readSnapshotFetching).toBe(false)
      expect(feed.readSnapshot?.lastReadSeq).toBe(60)
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
      expect(root).toHaveAttribute("data-pagination-enabled", "true")
    } finally { view.unmount(); owner.client.clear() }
  },
)

it.each(kinds.flatMap(kind => (["success", "offline", "timeout"] as const).map(result => ({ kind, result }))))(
  "reveals complete $kind cache through the real list during missing target work and $result",
  async ({ kind, result }) => {
    const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
    if (kind === "text-thread" || kind === "forum-post") {
      packet.channel = { ...packet.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
      packet.parent = { ...packet.channel, id: "parent", type: kind === "forum-post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
      packet.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
    }
    packet.messages = Array.from({ length: 42 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1 }))
    packet.readState = { ...packet.readState, lastReadMessageId: "m30", lastReadSeq: 30 }
    packet.selection = { reason: "read_pointer", anchorMessageId: "m30" }
    packet.page = { olderCursor: null, newerCursor: "newer", hasMoreOlder: false, hasMoreNewer: true, latestSeq: 80 }
    await seedConversationEntry(owner.client, packet)
    if (kind === "dm") ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [{ ...packet.readState, lastReadMessageId: "m60", lastReadSeq: 60, lastReadAt: packet.messages[0].createdAt }] })
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    let resolve!: (value: typeof packet) => void, reject!: (error: Error) => void
    load.mockReturnValue(new Promise<typeof packet>((yes, no) => { resolve = yes; reject = no }))
    let feed!: ReturnType<typeof useMessages>
    function Probe() {
      const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1", anchorMessageId: "m60" })
      const dm = useDmMessages(kind === "dm" ? "c1" : null)
      feed = kind === "dm" ? dm : channel
      const projection = resolveMessageReadProjection({ messages: feed.messages, lastReadMessageId: feed.readSnapshot?.lastReadMessageId ?? null, viewerUserId: "viewer", anchorReconciled: feed.anchorReconciled })
      return <MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
        loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
        initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
        positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
        newDividerBefore={projection.newDividerBefore} scrollToMessageId={kind === "dm" ? undefined : "m60"} hasMoreNewer={feed.hasMoreNewer}
        onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      const root = view.getByTestId("community-message-scroller")
      expect(feed.initialDisplayReady).toBe(true)
      expect(feed.initialPositionKnown).toBe(false)
      expect(feed.readSnapshotFetching).toBe(true)
      expect(feed.targetPositionDataState).toBe(kind === "dm" ? "ready" : "pending")
      expect(feed.positionDataState).toBe("pending")
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      expect(root.querySelectorAll("[data-msg-id]").length).toBeGreaterThan(0)
      expect(load.mock.calls.some(([path]) => path.endsWith(kind === "dm" ? "entry=1" : "entry=1&anchor=m60"))).toBe(true)
      expect(load.mock.calls.some(([path]) => path.endsWith("/read"))).toBe(false)
      const fresh = { ...packet, selection: { reason: kind === "dm" ? "read_pointer" as const : "explicit_anchor" as const, anchorMessageId: "m60" },
        ...(kind === "dm" ? { readState: { ...packet.readState, lastReadMessageId: "m60", lastReadSeq: 60 }, readStateRevision: 5 } : {}),
        messages: Array.from({ length: 22 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 59}`, seq: index + 59 })),
        page: { ...packet.page, hasMoreOlder: true, hasMoreNewer: false, newerCursor: null } }
      await act(async () => {
        if (result === "success") resolve(fresh)
        else if (result === "offline") reject(new Error("offline"))
        await vi.advanceTimersByTimeAsync(result === "timeout" ? 15000 : result === "offline" ? 2000 : 0)
      })
      resize()
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
      if (result === "success") {
        expect(feed.initialPositionKnown).toBe(true)
        expect(feed.messages.some(message => message.id === "m60")).toBe(true)
      } else {
        expect(feed.messages).toHaveLength(42)
        expect(feed.targetPositionDataState).toBe("error")
        expect(view.getByRole("alert")).toHaveTextContent("Couldn’t load the requested messages")
        let resume!: (value: typeof fresh) => void
        load.mockReturnValue(new Promise(yes => { resume = yes }))
        fireEvent.click(view.getByRole("button", { name: "Retry" }))
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.getByTestId("community-message-scroller")).toBe(root)
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
        await act(async () => { resume(fresh); await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(feed.initialPositionKnown).toBe(true)
        expect(view.queryByRole("alert")).toBeNull()
      }
    } finally { view.unmount(); owner.client.clear() }
  },
)

it.each(kinds)("keeps $0 display qualification separate from an unavailable canonical read snapshot", async kind => {
  const owner = await createCommunityQueryOwner()
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  if (kind === "text-thread" || kind === "forum-post") {
    packet.channel = { ...packet.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    packet.parent = { ...packet.channel, id: "parent", type: kind === "forum-post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
    packet.surfaceReceipt = { channelId: "c1", surfaceKind: "thread" }
  }
  await seedConversationEntry(owner.client, packet)
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  owner.registry.collections.readStates.utils.writeDelete("c1")
  if (owner.registry.collections.readStateClock.has("account")) owner.registry.collections.readStateClock.utils.writeDelete("account")
  load.mockReturnValue(new Promise(() => {}))
  const { useChannelMetadata } = await import("./use-channel-metadata")
  const { renderHook } = await import("@/test/react-dom-harness")
  const view = renderHook(() => {
    const metadata = useChannelMetadata(packet.channel.serverId, "c1")
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    return { metadata, feed: kind === "dm" ? dm : channel }
  }, { wrapper: ({ children }) => <CommunityTestProvider {...owner}>{children}</CommunityTestProvider> })
  try {
    resize()
    expect(view.result.current.metadata.status).toBe("readable")
    expect(view.result.current.metadata.windowReady).toBe(false)
    expect(view.result.current.feed.initialDisplayReady).toBe(true)
    expect(view.result.current.feed.initialPositionKnown).toBe(false)
    expect(view.result.current.feed.readSnapshotFetching).toBe(true)
    expect(view.result.current.feed.positionDataState).toBe("pending")
    expect(view.result.current.feed.navigationBlocked).toBe(true)
  } finally { view.unmount(); owner.client.clear() }
})
