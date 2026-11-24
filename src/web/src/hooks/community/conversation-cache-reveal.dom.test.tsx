import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, dmConversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { messageReadPageFixture } from "@/test/community-resource-fixtures"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { MessageList } from "@/components/community/messages/message-list"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "@/components/community/messages/conversation-footer-shell"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { dehydrate } from "@tanstack/react-query"
import { PERSIST_BUSTER, readCommunityRestoredCollections } from "@/lib/query-persister"
import { restoreConversationDisplayWindows } from "@/lib/community/restored-conversation-window"
import { useDmMessages, useMessages } from "./use-messages"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, scrollFixture } from "@/test/message-scroll-fixture"

type ScrollResult = ReturnType<typeof import("./use-conversation-scroll").useConversationScroll>
const preCommand = vi.hoisted(() => ({
  latest: null as unknown,
}))
vi.mock("./use-conversation-scroll", async original => {
  const actual = await original<typeof import("./use-conversation-scroll")>()
  return { ...actual, useConversationScroll: (...args: Parameters<typeof actual.useConversationScroll>) => {
    const result = actual.useConversationScroll(...args)
    preCommand.latest = result
    return result
  } }
})

const load = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: load }))
beforeEach(() => { installMessageScrollFixture(); load.mockReset(); preCommand.latest = null })
afterEach(restoreMessageScrollFixture)
const kinds = ["text", "text-thread", "forum-post", "dm"] as const

function expectSilentCachedList(view: ReturnType<typeof render>, root: HTMLElement, flowChildren: Element[]) {
  expect(view.queryByRole("alert")).toBeNull()
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
  const boundary = root.closest<HTMLElement>("[data-message-scroller-boundary]")!
  expect(Array.from(boundary.parentElement!.children)).toEqual(flowChildren)
  expect(root.querySelectorAll("[data-msg-id]").length).toBeGreaterThan(0)
  expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
}

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
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"} messages={feed.messages}
      loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
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
    expect(view.getByRole("textbox", { name: "Draft" })).toBeVisible()
    expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
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

it.each((["text", "dm"] as const).flatMap(kind => (["unchanged", "new messages", "offline", "takeover"] as const)
  .map(result => ({ kind, result }))))("keeps the restored $kind tail separate from historical jump admission through $result", async ({ kind, result }) => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  const rows = Array.from({ length: 60 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows.slice(0, 40)
  packet.channel.messageCount = 40
  packet.readState = { ...packet.readState, lastReadMessageId: "m40", lastReadSeq: 40, lastReadAt: rows[39].createdAt }
  packet.selection = { reason: "tail", anchorMessageId: null }
  packet.newBoundary = { afterSeq: 40, target: null }
  packet.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 40 }
  await seedConversationEntry(owner.client, packet)
  const restored = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) }, "viewer")
  owner.client.removeQueries({ queryKey: communityKeys.channelMessages("c1") })
  owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
  restoreConversationDisplayWindows(owner.registry, restored)
  let resolve!: (value: typeof packet) => void, reject!: (error: Error) => void
  load.mockReturnValue(new Promise<typeof packet>((yes, no) => { resolve = yes; reject = no }))
  let feed!: ReturnType<typeof useMessages>
  function Probe() {
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null)
    feed = kind === "dm" ? dm : channel
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"}
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} preserveInitialPresentation={feed.preserveInitialPresentation}
      positionScope={feed.positionScope} positionEntry={feed.positionEntry} positionDataState={feed.positionDataState}
      targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      newBoundary={feed.newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
      onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary}
      hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      isFetchingNewer={feed.isFetchingNewer}
      onJumpToPresent={feed.jumpToPresent} presentVersion={feed.presentVersion} presentRequest={feed.presentRequest}
      onUserTakeover={feed.onUserTakeover} onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  const tailPhases: Array<{ phase: string; clearance: number; trailingSize: number; footerHeight: number; paddingEnd: number; hasMoreNewer: boolean; positionDataState: string }> = []
  const tailWrites: unknown[] = []
  let tailPhase = "restored-pending"
  const captureTail = (phase: string) => {
    const root = view.getByTestId("community-message-scroller")
    const body = root.querySelector<HTMLElement>('[data-msg-id="m40"]')!
    const position = preCommand.latest as ScrollResult
    const trailing = root.querySelector<HTMLElement>('[data-message-row-key="rail:trailing"]')?.closest<HTMLElement>("[data-index]")
    const row = { phase, clearance: root.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom,
      trailingSize: trailing?.getBoundingClientRect().height ?? 0,
      footerHeight: view.container.querySelector<HTMLElement>('[data-slot="community-conversation-footer"]')?.getBoundingClientRect().height ?? 0,
      paddingEnd: Number.parseFloat(root.querySelector<HTMLElement>("[data-message-rows]")?.style.paddingBottom ?? "0") || 0, hasMoreNewer: feed.hasMoreNewer, positionDataState: feed.positionDataState,
      hasMoreOlder: feed.hasMoreOlder, readReady: position.readPositionReady, positionOutcome: position.positionOutcome,
      scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight }
    tailPhases.push(row)
    return row
  }
  try {
    resize()
    const root = view.getByTestId("community-message-scroller")
    const draft = view.getByRole("textbox", { name: "Draft" })
    expect(root).toHaveAttribute("aria-busy", "false")
    expect(root.querySelector('[data-msg-id="m40"]')).not.toBeNull()
    expect(feed.hasMoreNewer).toBe(true)
    expect(feed.positionDataState).toBe("pending")
    expect(root).toHaveAttribute("data-pagination-enabled", "false")
    expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
    const cachedTail = result === "unchanged" ? captureTail("restored-pending") : null
    if (cachedTail) {
      const originalScrollTo = HTMLElement.prototype.scrollTo
      vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function(this: HTMLElement, ...args: [options?: ScrollToOptions] | [x: number, y: number]) {
        const before = this.scrollTop
        Reflect.apply(originalScrollTo, this, args)
        if (this === root) tailWrites.push({ phase: tailPhase, before, requested: typeof args[0] === "number" ? args[1] : args[0]?.top, after: this.scrollTop,
          nativeStack: new Error().stack?.split("\n").filter(line => /resizeItem|applyScrollAdjustment|_scrollToOffset|setOptions/.test(line)) })
      })
    }
    fireEvent.change(draft, { target: { value: "Local draft" } })
    expect(draft).toHaveValue("Local draft")
    let readerId: string | undefined, readerOffset = 0
    if (result === "takeover") {
      fireEvent.wheel(root, { deltaY: -1500 })
      act(() => root.scrollTo({ top: 1500 }))
      resize()
      const reader = Array.from(root.querySelectorAll<HTMLElement>("[data-msg-id]")).find(row => row.getBoundingClientRect().bottom > root.getBoundingClientRect().top + 1)!
      readerId = reader.dataset.msgId
      readerOffset = reader.getBoundingClientRect().top - root.getBoundingClientRect().top
      expect(view.getByRole("button", { name: "Jump to present" })).toBeVisible()
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
    }
    if (result === "offline") {
      await act(async () => { reject(new Error("offline")); await vi.advanceTimersByTimeAsync(2000) })
      resize()
      expect(root).toHaveAttribute("aria-busy", "false")
      expect(root.querySelector('[data-msg-id="m40"]')).not.toBeNull()
      expect(feed.hasMoreNewer).toBe(true)
      expect(root.querySelector('[data-read-position-ready="true"]')).toBeNull()
      expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
    } else {
      const freshRows = result === "unchanged" ? rows.slice(0, 40) : rows
      const fresh = { ...packet, channel: { ...packet.channel, messageCount: freshRows.length }, messages: freshRows,
        newBoundary: { afterSeq: 40, target: result === "unchanged" ? null : { id: "m41", channelId: "c1", seq: 41, authorId: "peer" } },
        page: { ...packet.page, latestSeq: freshRows.length } }
      tailPhase = "entry-confirmation"
      await act(async () => { resolve(fresh); await vi.advanceTimersByTimeAsync(0) })
      tailPhase = "confirmation-resize-and-frames"
      resize()
      const confirmedTail = cachedTail ? captureTail("confirmed-unchanged") : null
      expect(view.getByTestId("community-message-scroller")).toBe(root)
      if (result === "takeover") {
        const reader = root.querySelector<HTMLElement>(`[data-msg-id="${readerId}"]`)!
        expect(reader).not.toBeNull()
        expect(Math.abs(reader.getBoundingClientRect().top - root.getBoundingClientRect().top - readerOffset)).toBeLessThanOrEqual(1)
        expect(view.getByTestId("community-scroll-to-present")).toBeVisible()
      } else {
        expect(feed.hasMoreNewer).toBe(false)
        expect(feed.messages.at(-1)?.id).toBe(result === "unchanged" ? "m40" : "m60")
        expect(root.scrollHeight - root.clientHeight - root.scrollTop).toBeLessThanOrEqual(1)
        expect(view.queryByTestId("community-scroll-to-present")).toBeNull()
        if (cachedTail && confirmedTail) {
          expect(confirmedTail.clearance).toBeCloseTo(40, 0)
          expect(cachedTail.clearance).toBeCloseTo(confirmedTail.clearance, 0)
        }
      }
    }
    expect(draft).toHaveValue("Local draft")
  } finally {
    if (tailPhases.length) console.info("tail-gap327", JSON.stringify({ kind, result, phases: tailPhases, writes: tailWrites }))
    view.unmount(); owner.client.clear()
  }
})

it.each(["text", "dm"] as const)("shows the $0 newer loading row through a real cursor request while retaining its boundary", async kind => {
  scrollFixture.width = 390
  const owner = await createCommunityQueryOwner("viewer", { defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const packet = kind === "dm" ? dmConversationEntryFixture() : conversationEntryFixture()
  const rows = Array.from({ length: 80 }, (_, index) => ({ ...packet.messages[0], id: `m${index + 1}`, seq: index + 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
  packet.messages = rows.slice(0, 40)
  packet.channel.messageCount = 80
  packet.readState = { ...packet.readState, lastReadMessageId: "m20", lastReadSeq: 20, lastReadAt: rows[19].createdAt }
  packet.selection = { reason: "explicit_anchor", anchorMessageId: "m20" }
  packet.newBoundary = { afterSeq: 20, target: { id: "m21", channelId: "c1", seq: 21, authorId: "peer" } }
  const cursor = `${rows[39].createdAt}|m40`
  packet.page = { olderCursor: null, newerCursor: cursor, hasMoreOlder: false, hasMoreNewer: true, latestSeq: 80 }
  await seedConversationEntry(owner.client, packet, { channelId: "c1", serverId: packet.channel.serverId, anchorMessageId: "m20", newAfterSeq: 20 })
  let release!: (value: ReturnType<typeof messageReadPageFixture>) => void
  const newer = new Promise<ReturnType<typeof messageReadPageFixture>>(resolve => { release = resolve })
  load.mockImplementation((url: string) => {
    const search = new URL(url, "https://example.test").searchParams
    if (search.has("entry")) return Promise.resolve(packet)
    if (search.get("since") === cursor) return newer
    throw new Error(`Unexpected message request ${url}`)
  })
  let feed!: ReturnType<typeof useMessages>
  function Probe() {
    const channel = useMessages(kind === "dm" ? null : "c1", { serverId: "s1", anchorMessageId: "m20" })
    const dm = useDmMessages(kind === "dm" ? "c1" : null, { anchorMessageId: "m20" })
    feed = kind === "dm" ? dm : channel
    return <ConversationFooterSlotProvider><div data-slot="community-conversation-surface"><MessageList channel="Channel" variant={kind === "dm" ? "dm" : "channel"}
      messages={feed.messages} loading={feed.isLoading} initialLoadError={feed.initialLoadError} targetLoadError={feed.targetLoadError}
      initialScrollReady={feed.initialDisplayReady} positionScope={feed.positionScope} positionEntry={feed.positionEntry}
      positionDataState={feed.positionDataState} targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
      scrollToMessageId="m20" hasMore={feed.hasMoreOlder} hasMoreNewer={feed.hasMoreNewer}
      isFetching={feed.isFetching} isFetchingNewer={feed.isFetchingNewer} onLoadNewer={feed.fetchNewer}
      onUserTakeover={feed.onUserTakeover} onOpenThread={() => {}} />
      <ConversationFooterShell><textarea aria-label="Draft" /></ConversationFooterShell>
    </div></ConversationFooterSlotProvider>
  }
  const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
  const lastKey = () => {
    const rows = view.getByTestId("community-message-scroller").querySelectorAll<HTMLElement>("[data-message-row-key]")
    return rows.item(rows.length - 1)?.dataset.messageRowKey ?? null
  }
  try {
    expect(feed.isFetchingNewer).toBe(false)
    expect(lastKey()).not.toBe("rail:trailing")
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    const root = view.getByTestId("community-message-scroller")
    expect(feed.positionDataState).toBe("ready")
    expect(feed.hasMoreNewer).toBe(true)
    expect(feed.isFetchingNewer).toBe(true)
    expect(lastKey()).toBe("rail:trailing")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "true")
    expect(load.mock.calls.filter(([url]) => new URL(url, "https://example.test").searchParams.get("since") === cursor)).toHaveLength(1)
    const readingPage = feed.messageNeighborhood!.page
    fireEvent.wheel(root, { deltaY: root.scrollHeight })
    act(() => root.scrollTo({ top: root.scrollHeight - root.clientHeight }))
    resize()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    resize()
    expect(load.mock.calls.filter(([url]) => new URL(url, "https://example.test").searchParams.get("since") === cursor)).toHaveLength(1)
    expect(feed.isFetchingNewer).toBe(true)
    expect(feed.hasMoreNewer).toBe(true)
    expect(lastKey()).toBe("rail:trailing")
    expect(view.getByText("Loading newer messages…")).toBeVisible()
    await act(async () => {
      release(messageReadPageFixture({ messages: rows.slice(40, 60), profiles: packet.profiles, latestSeq: 80,
        hasMoreOlder: true, hasMoreNewer: true, olderCursor: `${rows[40].createdAt}|m41`, newerCursor: `${rows[59].createdAt}|m60` }))
      await vi.advanceTimersByTimeAsync(0)
    })
    resize()
    expect(feed.isFetchingNewer).toBe(false)
    expect(feed.hasMoreNewer).toBe(true)
    expect(feed.messages.at(-1)?.id).toBe("m60")
    expect(feed.messageWindow?.pageParams).toEqual([{ mode: "newer", cursor }, { mode: "anchor", anchor: "m20" }])
    expect(lastKey()).not.toBe("rail:trailing")
    expect(view.queryByText("Loading newer messages…")).toBeNull()
    expect(feed.messageNeighborhood!.page).toBe(readingPage)
    expect(load.mock.calls.filter(([url]) => new URL(url, "https://example.test").searchParams.get("since") === cursor)).toHaveLength(1)
  } finally { view.unmount(); owner.client.clear() }
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
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
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
      const initialRoot = root
      const flowChildren = Array.from(root.closest<HTMLElement>("[data-message-scroller-boundary]")!.parentElement!.children)
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
      expect(root).toBe(initialRoot)
      expectSilentCachedList(view, root, flowChildren)
      expect(feed.initialLoadError).toBeNull()
      expect(feed.targetLoadError).toBeInstanceOf(Error)
      expect(feed.targetPositionDataState).toBe("error")
      expect(root).toHaveAttribute("data-pagination-enabled", "false")
      expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
      expect(root.querySelector('[data-msg-id="m35"]')).toBe(cachedTail)
      expect(Math.abs(cachedTail.getBoundingClientRect().top - root.getBoundingClientRect().top - cachedTailOffset)).toBeLessThanOrEqual(1)
      let release!: (value: typeof packet) => void
      const retry = new Promise<typeof packet>(resolve => { release = resolve })
      const repairPage = { ...packet.page, latestSeq: 80, profiles: packet.profiles, messages: rows.slice(35) }
      let failRepair = repairFailure
      load.mockImplementation((url: string) => url.includes("entry=1") ? retry
        : failRepair ? Promise.reject(new Error("owned window repair failed")) : Promise.resolve(repairPage))
      act(() => feed.retryInitialLoad())
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
      expectSilentCachedList(view, root, flowChildren)
      expect(feed.initialLoadError).toBeNull()
      if (repairFailure) {
        expect(feed.targetLoadError).toBeInstanceOf(Error)
        expect(feed.targetPositionDataState).toBe("error")
      } else expect(feed.targetLoadError).toBeNull()
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
        act(() => feed.retryInitialLoad())
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expectSilentCachedList(view, root, flowChildren)
        expect(feed.targetLoadError).toBeInstanceOf(Error)
        expect(feed.targetPositionDataState).toBe("error")
        expect(root).toHaveAttribute("data-pagination-enabled", "false")
        expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
        expect(root).toHaveAttribute("aria-busy", "false")
        expect(feed.messages.map(row => row.id)).toContain(readerId)
        failRepair = false
        act(() => feed.retryInitialLoad())
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expectSilentCachedList(view, root, flowChildren)
        expect(feed.targetLoadError).toBeNull()
        expect(feed.retryingInitialLoad).toBe(false)
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
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage}
        newBoundary={newBoundary} latestSeq={feed.latestSeq} retiredNewTargetId={feed.retiredNewTargetId}
        onLoadNewTarget={feed.loadNewTarget} onReadNewBoundary={feed.readNewBoundary} scrollToMessageId="m60" hasMoreNewer={feed.hasMoreNewer}
        onRetryInitialLoad={feed.retryInitialLoad} retryingInitialLoad={feed.retryingInitialLoad} onOpenThread={() => {}} />
    }
    const view = render(<CommunityTestProvider {...owner}><Probe /></CommunityTestProvider>)
    try {
      resize()
      const root = view.getByTestId("community-message-scroller")
      const flowChildren = Array.from(root.closest<HTMLElement>("[data-message-scroller-boundary]")!.parentElement!.children)
      const cachedBody = root.querySelector<HTMLElement>("[data-msg-id]")!
      const cachedBodyId = cachedBody.dataset.msgId!
      const cachedOffset = cachedBody.getBoundingClientRect().top - root.getBoundingClientRect().top
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
        expectSilentCachedList(view, root, flowChildren)
        expect(feed.initialLoadError).toBeNull()
        expect(feed.targetLoadError).toBeInstanceOf(Error)
        expect(root.querySelector(`[data-msg-id="${cachedBodyId}"]`)).toBe(cachedBody)
        expect(Math.abs(cachedBody.getBoundingClientRect().top - root.getBoundingClientRect().top - cachedOffset)).toBeLessThanOrEqual(1)
        expect(root).toHaveAttribute("data-pagination-enabled", "false")
        expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
        let resume!: (value: typeof fresh) => void
        load.mockReturnValue(new Promise(yes => { resume = yes }))
        act(() => feed.retryInitialLoad())
        await act(async () => { await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(view.getByTestId("community-message-scroller")).toBe(root)
        expect(root).toHaveAttribute("aria-busy", "false")
        expectSilentCachedList(view, root, flowChildren)
        expect(feed.retryingInitialLoad).toBe(true)
        expect(root).toHaveAttribute("data-pagination-enabled", "false")
        expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
        expect(root.querySelector(`[data-msg-id="${cachedBodyId}"]`)).toBe(cachedBody)
        await act(async () => { resume(fresh); await vi.advanceTimersByTimeAsync(0) })
        resize()
        expect(feed.initialPositionKnown).toBe(true)
        expectSilentCachedList(view, root, flowChildren)
        expect(feed.initialLoadError).toBeNull()
        expect(feed.targetLoadError).toBeNull()
        expect(feed.targetPositionDataState).toBe("ready")
        expect(feed.retryingInitialLoad).toBe(false)
        expect(root.querySelector('[data-msg-id="m60"]')).not.toBeNull()
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
      targetPositionDataState={feed.targetPositionDataState} messageWindow={feed.messageWindow}
      messageNeighborhood={feed.messageNeighborhood} onReadingMessage={feed.onReadingMessage} onOpenThread={() => {}} />
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
