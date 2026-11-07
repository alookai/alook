import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { MessageList } from "@/components/community/messages/message-list"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "@/components/community/messages/conversation-footer-shell"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { useDmMessages, useMessages } from "./use-messages"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

type ScrollResult = ReturnType<typeof import("./use-scroll-anchor").useScrollAnchor>
const preCommand = vi.hoisted(() => ({
  latest: null as unknown,
  finishes: [] as Array<{ kind: string; entry?: object | null; reason: string; source?: string }>,
}))
vi.mock("./use-scroll-anchor", async original => {
  const actual = await original<typeof import("./use-scroll-anchor")>()
  return { ...actual, useScrollAnchor: (...args: Parameters<typeof actual.useScrollAnchor>) => {
    const result = actual.useScrollAnchor(...args)
    preCommand.latest = result
    return result
  } }
})
vi.mock("@/lib/observability/position", async original => {
  const actual = await original<typeof import("@/lib/observability/position")>()
  return { ...actual, beginPositionObservation: (...args: Parameters<typeof actual.beginPositionObservation>) => {
    const finish = actual.beginPositionObservation(...args)
    let observed = false
    return (...end: Parameters<typeof finish>) => {
      if (!observed) preCommand.finishes.push({ kind: args[0], entry: args[2], reason: end[0], source: end[1]?.position_source })
      observed = true
      return finish(...end)
    }
  } }
})

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
beforeEach(() => { installMessageScrollFixture(); load.mockReset(); preCommand.latest = null; preCommand.finishes = [] })
afterEach(restoreMessageScrollFixture)
const kinds = ["text", "text-thread", "forum-post", "dm"] as const

it.each(["text", "dm"] as const)("reveals the qualified $0 history cache while ordinary tail coverage is pending", async kind => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows.slice(0, 35)
  packet.readState = { ...packet.readState, lastReadMessageId: "m35", lastReadSeq: 35, lastReadAt: rows[34].createdAt }
  packet.selection = { reason: "read_pointer", anchorMessageId: "m35" }
  packet.newBoundary = { afterSeq: 35, target: { id: "m36", channelId: "c1", seq: 36, authorId: "peer" } }
  packet.page = { olderCursor: null, newerCursor: `${rows[34].createdAt}|m35`, hasMoreOlder: false, hasMoreNewer: true, latestSeq: 80 }
  await seedConversationEntry(owner.client, packet, { channelId: "c1", serverId: packet.channel.serverId, preferTail: false })
  const read = { ...packet.readState, lastReadMessageId: "m80", lastReadSeq: 80, lastReadAt: rows[79].createdAt }
  ingestReadStateSnapshot(owner.registry, { revision: 5, readStates: [read] })
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  let release!: (value: typeof packet) => void
  load.mockReturnValue(new Promise(resolve => { release = resolve }))
  let feed!: ReturnType<typeof useMessages>
  function Probe() {
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    feed = kind === "dm" ? dm : channel
    const newBoundary = feed.newBoundary
    return <MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
      loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  const phases: unknown[] = []
  try {
    resize()
    let root = view.getByTestId("community-message-scroller")
    const capture = (phase: string) => phases.push({ phase, scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
      distanceToEnd: root.scrollHeight - root.clientHeight - root.scrollTop, first: feed.messages[0]?.id, last: feed.messages.at(-1)?.id,
      hasMoreNewer: feed.hasMoreNewer, positionDataState: feed.positionDataState, busy: root.getAttribute("aria-busy") })
    capture("cached-history-visible")
    expect(root).toHaveAttribute("aria-busy", "false")
    expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
    expect(feed.messages.map(message => message.id)).toEqual(rows.slice(0, 35).map(message => message.id))
    expect(feed.readSnapshotFetching).toBe(true)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(root).toHaveAttribute("data-pagination-enabled", "false")
    const fresh = { ...packet, messages: rows.slice(34), readState: read, readStateRevision: 5,
      selection: { reason: "tail" as const, anchorMessageId: null }, newBoundary: { afterSeq: 80, target: null },
      page: { olderCursor: `${rows[34].createdAt}|m35`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
    await act(async () => { release(fresh); await vi.advanceTimersByTimeAsync(0) })
    resize()
    capture("entry-refresh")
    root = view.getByTestId("community-message-scroller")
    expect(feed.messages.at(-1)?.id).toBe("m80")
    expect(root.querySelector("[data-new-divider]")).toBeNull()
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
    expect(root.querySelector('[data-msg-id="m80"]')).not.toBeNull()
  } finally {
    console.info("ordinary-cache-tail-phases", JSON.stringify({ kind, phases }))
    view.unmount(); owner.client.clear()
  }
})

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
    packet.selection = { reason: "tail", anchorMessageId: null }
    packet.newBoundary = { afterSeq: 10, target: { id: "m11", channelId: "c1", seq: 11, authorId: "peer" } }
    packet.channel.messageCount = 35
    packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 35 }
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
      const newBoundary = feed.newBoundary
      return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
        loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
        initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
        positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
        newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
        onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
        <ConversationFooterShell><div>composer</div></ConversationFooterShell>
      </div></ConversationFooterSlotProvider>
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      let root = view.getByTestId("community-message-scroller")
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
      const cachedTail = root.querySelector<HTMLElement>('[data-msg-id="m35"]')!
      expect(cachedTail).not.toBeNull()
      const cachedTailOffset = cachedTail.getBoundingClientRect().top - root.getBoundingClientRect().top
      expect(root.querySelector('[data-read-position-ready="true"]')).toBeNull()
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      await act(async () => { reject(new Error("held entry failed")); await vi.advanceTimersByTimeAsync(2000) })
      resize()
      root = view.getByTestId("community-message-scroller")
      expect(root.querySelector('[data-msg-id="m35"]')).toBe(cachedTail)
      expect(Math.abs(cachedTail.getBoundingClientRect().top - root.getBoundingClientRect().top - cachedTailOffset)).toBeLessThanOrEqual(1)
      let release!: (value: typeof packet) => void
      const retry = new Promise<typeof packet>(resolve => { release = resolve })
      const repairPage = { ...packet.page, latestSeq: 80, profiles: packet.profiles, messages: rows.slice(35) }
      let failRepair = repairFailure
      load.mockImplementation((url: string) => url.includes("entry=1") ? retry
        : failRepair ? Promise.reject(new Error("owned window repair failed")) : Promise.resolve(repairPage))
      fireEvent.click(view.getByRole("button", { name: "Retry" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      if (takeover) {
        fireEvent.wheel(root, { deltaY: 1000 })
        act(() => root.scrollTo({ top: 1000 }))
        resize()
      }
      expect(root).toHaveAttribute("aria-busy", "false")
      const viewport = root.getBoundingClientRect()
      const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(row => row.getBoundingClientRect().bottom > viewport.top + 1)!
      const readerId = reader.dataset.msgId!
      const offset = reader.getBoundingClientRect().top - viewport.top
      expect(Number(readerId.slice(1))).toBeLessThan(35)
      const fresh = { ...packet, channel: { ...packet.channel, messageCount: 80 }, messages: rows.slice(59), readState: read, readStateRevision: 5,
        selection: { reason: "tail" as const, anchorMessageId: null }, newBoundary: { afterSeq: 60, target: { id: "m61", channelId: "c1", seq: 61, authorId: "peer" } },
        page: { olderCursor: `${rows[59].createdAt}|m60`, newerCursor: null, hasMoreOlder: true, hasMoreNewer: false, latestSeq: 80 } }
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
        expect(feed.messages.map(row => row.id)).toEqual(rows.map(row => row.id))
        expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
        expect(feed.newBoundary?.target?.id).toBe("m61")
        expect(view.getByRole("button", { name: "Jump to New" })).toBeVisible()
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
    packet.selection = { reason: "tail", anchorMessageId: null }
    packet.newBoundary = { afterSeq: 30, target: { id: "m31", channelId: "c1", seq: 31, authorId: "peer" } }
    packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }
    await seedConversationEntry(owner.client, packet)
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    let resolve!: (value: typeof packet) => void, reject!: (error: Error) => void
    load.mockReturnValue(new Promise<typeof packet>((yes, no) => { resolve = yes; reject = no }))
    let feed!: ReturnType<typeof useMessages>
    function Probe() {
      const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1", anchorMessageId: "m60" })
      const dm = useDmMessages(kind === "dm" ? "c1" : null, { anchorMessageId: "m60" })
      feed = kind === "dm" ? dm : channel
      const newBoundary = feed.newBoundary
      return <MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
        loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
        initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
        positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
        newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} scrollToMessageId="m60" hasMoreNewer={feed.hasMoreNewer}
        onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      const root = view.getByTestId("community-message-scroller")
      expect(feed.initialDisplayReady).toBe(true)
      expect(feed.initialPositionKnown).toBe(false)
      expect(feed.readSnapshotFetching).toBe(true)
      expect(feed.targetPositionDataState).toBe("pending")
      expect(feed.positionDataState).toBe("pending")
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      expect(root.querySelectorAll("[data-msg-id]").length).toBeGreaterThan(0)
      expect(load.mock.calls.some(([path]) => new URL(path, "https://test.invalid").searchParams.get("anchor") === "m60")).toBe(true)
      expect(load.mock.calls.some(([path]) => path.endsWith("/read"))).toBe(false)
      const fresh = { ...packet, selection: { reason: "explicit_anchor" as const, anchorMessageId: "m60" },
        messages: Array.from({ length: 22 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 59}`, seq: index + 59 })),
        page: { ...packet.page, latestSeq: 80, hasMoreOlder: true, hasMoreNewer: false, newerCursor: null } }
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
  let latest!: { metadata: ReturnType<typeof useChannelMetadata>; feed: ReturnType<typeof useMessages> }
  function Probe() {
    const metadata = useChannelMetadata(packet.channel.serverId, "c1")
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    const feed = kind === "dm" ? dm : channel
    latest = { metadata, feed }
    return <MessageList channel="Conversation" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
      loading={feed.isLoading} initialLoadError={feed.initialLoadError} initialScrollReady={feed.initialDisplayReady}
      positionScope={feed.positionScope} positionEntry={feed.positionEntry} positionDataState={feed.positionDataState}
      targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow} onOpenThread={() => {}} />
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  try {
    resize()
    expect(latest.metadata.status).toBe("readable")
    expect(latest.metadata.windowReady).toBe(false)
    expect(latest.feed.initialDisplayReady).toBe(true)
    expect(latest.feed.readSnapshot).toBeNull()
    expect(latest.feed.initialPositionKnown).toBe(false)
    expect(latest.feed.readSnapshotFetching).toBe(true)
    expect(latest.feed.positionDataState).toBe("pending")
    expect(latest.feed.navigationBlocked).toBe(true)
    const root = view.getByTestId("community-message-scroller")
    expect(root).toHaveAttribute("aria-busy", "false")
    expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(root).toHaveAttribute("data-pagination-enabled", "false")
    expect(view.getByText("Body")).toBeVisible()
  } finally { view.unmount(); owner.client.clear() }
})


it.each([
  { name: "keeps ordinary cached tail ownership through its own pre-command row measurement", external: false },
  { name: "keeps unlabelled takeover through following native row compensation", external: true },
])("$name", async ({ external }) => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = dmConversationEntryFixture()
  const rows = Array.from({ length: 60 }, (_, index) => ({ ...packet.messages[0], id: "ro" + (index + 1), seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows
  packet.channel.messageCount = 60
  packet.readState = { ...packet.readState, lastReadMessageId: "ro60", lastReadSeq: 60, lastReadAt: rows[59].createdAt }
  packet.selection = { reason: "tail", anchorMessageId: null }
  packet.newBoundary = { afterSeq: 60, target: null }
  packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 60 }
  await seedConversationEntry(owner.client, packet)
  load.mockResolvedValue(packet)
  const href = "/c/me/c1"
  let navigation = { entryIntent: { href }, publishedHref: href, pendingHref: null, navigationPending: false }
  let nextIntent: { href: string } | null = null
  let feed!: ReturnType<typeof useDmMessages>
  let newDivider: string | undefined
  const handovers = vi.fn(() => feed.onUserTakeover())
  function Probe() {
    feed = useDmMessages("c1")
    const newBoundary = feed.newBoundary
    newDivider = newBoundary?.target?.id
    return <MessageList channel="DM" variant="dm" messages={feed.messages} loading={feed.isLoading}
      initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      initialPositionMessageId={feed.initialPositionMessageId} newDividerBefore={newDivider}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      isFetching={feed.isFetching} isFetchingOlder={feed.isFetchingOlder} isFetchingNewer={feed.isFetchingNewer}
      onUserTakeover={handovers} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
  }
  function Page() {
    return <CommunityTestProvider {...owner}>
      <CommunityRouteContext value={{ breakpoint: "mobile", frame: { revision: nextIntent ? 2 : 1 }, navigation } as never}>
        <Probe />
      </CommunityRouteContext>
    </CommunityTestProvider>
  }
  const view = render(<Page />)
  const phases: unknown[] = []
  const writes: unknown[] = []
  let phase = "warm"
  let inputs = 0
  const input = () => { inputs++ }
  const current = () => preCommand.latest as ScrollResult
  const geometry = () => {
    const root = view.getByTestId("community-message-scroller")
    return { at: performance.now(), scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight,
      distanceToEnd: root.scrollHeight - root.clientHeight - root.scrollTop, outcome: current().positionOutcome,
      readReady: current().readPositionReady, inputCount: inputs, first: feed.messages[0]?.id, last: feed.messages.at(-1)?.id }
  }
  try {
    resize()
    const root = view.getByTestId("community-message-scroller")
    const native = current().virtualizer
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
    for (const kind of ["wheel", "keydown", "pointerdown", "touchstart"]) root.addEventListener(kind, input)
    phase = "old-user-setup"
    fireEvent.wheel(root, { deltaY: -2000 })
    act(() => root.scrollTo({ top: 2000 }))
    resize()
    expect(root.scrollTop).toBeGreaterThan(0)
    expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeGreaterThan(500)
    expect(native.isScrolling).toBe(false)
    const selected = native.getVirtualItems().findLast(row => String(row.key).startsWith("msg:") && row.end <= root.scrollTop)
    expect(selected, "Preparation invalid: no mounted above-fold row").toBeDefined()
    const wrapper = root.querySelector<HTMLElement>("[data-index='" + selected!.index + "']")
    expect(wrapper, "Preparation invalid: native row wrapper is not mounted").not.toBeNull()
    expect(wrapper!.querySelector<HTMLElement>("[data-message-row-key]")?.dataset.messageRowKey).toBe(String(selected!.key))
    const body = wrapper!.querySelector<HTMLElement>("[data-msg-id]")
    expect(body, "Preparation invalid: mounted row has no message body").not.toBeNull()
    const id = body!.dataset.msgId!
    expect(id).toBeTruthy()
    const bodyHeight = body!.getBoundingClientRect().height
    const originalScrollTo = HTMLElement.prototype.scrollTo
    vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function(this: HTMLElement, ...args: [options?: ScrollToOptions] | [x: number, y: number]) {
      const before = this.scrollTop
      Reflect.apply(originalScrollTo, this, args)
      writes.push({ phase, before, requested: typeof args[0] === "number" ? args[1] : args[0]?.top, after: this.scrollTop, inputCount: inputs,
        nativeResizeStack: new Error().stack?.split("\n").filter(line => /resizeItem|applyScrollAdjustment|_scrollToOffset/.test(line)) })
    })
    const end = vi.spyOn(native, "scrollToEnd")
    const measure = vi.spyOn(native, "resizeItem")
    const inputBaseline = inputs
    handovers.mockClear()
    nextIntent = { href }
    navigation = { ...navigation, entryIntent: nextIntent }
    phase = "new-entry-before-first-frame"
    view.rerender(<Page />)
    expect(view.getByTestId("community-message-scroller")).toBe(root)
    expect(current().virtualizer).toBe(native)
    expect(native.scrollElement).toBe(root)
    expect(feed.positionEntry).toBe(nextIntent)
    expect(feed.readSnapshot?.lastReadMessageId).toBe("ro60")
    expect(feed.readSnapshot?.lastReadSeq).toBe(60)
    expect(feed.initialPositionMessageId).toBeNull()
    expect(newDivider).toBeUndefined()
    expect(feed.positionDataState).toBe("ready")
    expect(native.options.anchorTo).toBe("start")
    expect(end).not.toHaveBeenCalled()
    const origin = root.scrollTop
    phases.push({ phase, ...geometry(), pointer: feed.readSnapshot?.lastReadSeq, initialTarget: feed.initialPositionMessageId, newDivider })
    if (external) {
      phase = "external-unlabelled-negative-control"
      act(() => root.scrollTo({ top: origin + 100 }))
      phases.push({ phase, ...geometry() })
    }
    const beforeNative = root.scrollTop
    phase = "one-row-native-ro"
    scrollFixture.bodyHeights.set(id, bodyHeight + 40)
    resize(0)
    phases.push({ phase, ...geometry(), row: id, nativeResizeCalls: measure.mock.calls.map(([index, size]) => ({ index, size })),
      firstEndCalls: end.mock.calls.length, nativeOffset: native.scrollOffset })
    expect(measure.mock.calls.some(([index]) => index === selected!.index), "Preparation invalid: selected row was not measured through RO").toBe(true)
    expect(Math.abs(root.scrollTop - beforeNative), "Preparation invalid: no automatic native offset change").toBeGreaterThan(1)
    expect(inputs).toBe(inputBaseline)
    expect(end).not.toHaveBeenCalled()
    phase = "new-entry-first-frames"
    runFrames()
    phases.push({ phase, ...geometry(), firstEndCalls: end.mock.calls.length, newHandovers: handovers.mock.calls.length })
    const decisions = preCommand.finishes.filter(event => event.entry === nextIntent)
    expect(decisions.some(event => event.source === "tail"), "Preparation invalid: no actual tail decision").toBe(true)
    expect(inputs).toBe(inputBaseline)
    if (external) {
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeGreaterThan(500)
      expect(decisions.some(event => event.reason === "origin_changed")).toBe(true)
      expect(handovers).toHaveBeenCalledOnce()
      expect(end).not.toHaveBeenCalled()
    } else {
      expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
      expect(decisions.some(event => event.reason === "origin_changed")).toBe(false)
      expect(handovers).not.toHaveBeenCalled()
      expect(end).toHaveBeenCalledOnce()
    }
  } finally {
    console.info("pre-command-row-measurement-facts", JSON.stringify({ phases, writes, decisions: preCommand.finishes.map(({ kind, entry, reason, source }) => ({ kind, entry: entry === nextIntent ? "new" : "old", reason, source })) }))
    view.unmount()
    owner.client.clear()
  }
})
