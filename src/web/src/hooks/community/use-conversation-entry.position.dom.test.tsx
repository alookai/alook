import { messageProfilesFixture } from "@/test/community-resource-fixtures"
import { resourceBundleFixture } from "@/test/community-resource-fixtures"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StrictMode, useLayoutEffect } from "react"
import { useChannelMessageFeed } from "./use-channel-message-feed"
import { useMessageChannelController } from "@/components/community/messages/message-channel-controller-state"
import { MessageList } from "@/components/community/messages/message-list"
import { ConversationFooterShell, ConversationFooterSlotProvider } from "@/components/community/messages/conversation-footer-shell"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { ConversationActivityContext } from "@/contexts/view-activity"
import { dehydrate, IsRestoringProvider, QueryClientProvider } from "@tanstack/react-query"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, scrollFixture } from "@/test/message-scroll-fixture"
import { captureCommunityLiveSnapshotToken, ingestReadStateSnapshot, publishAccountAttentionSnapshot } from "@/lib/community-db/sync"
import { currentConversationReadState } from "@/lib/community/conversation-entry"
import { disposeReadCoordinator, getLocalReadingPosition, getReadCoordinator, READ_COORDINATOR_DEBOUNCE_MS } from "./read-coordinator"
import { disposeAccountReadStateReconciliation, type AccountReadStateSnapshot } from "./community-ws/read-state-reconciliation"
import { PERSIST_BUSTER, readCommunityRestoredCollections } from "@/lib/query-persister"
import { restoreConversationDisplayWindows } from "@/lib/community/restored-conversation-window"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityCollectionChanges } from "@/lib/community-db/write"

const navigationMock = vi.hoisted(() => ({ href: "/c/channels/s1/c1", replace: vi.fn() }))
const load = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigationMock.replace }),
  usePathname: () => navigationMock.href.split("?")[0],
  useSearchParams: () => new URLSearchParams(navigationMock.href.split("?")[1]),
}))
vi.mock("@/lib/api/client", async original => ({
  ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => load(...args),
}))
vi.mock("./use-channel-panels", () => ({
  usePins: () => ({ pins: [], isLoading: false }),
  useThreads: () => ({ threads: [], isLoading: false }),
}))
vi.mock("./mutations", () => ({
  useSendMessage: () => ({ mutateAsync: vi.fn() }),
  useToggleReactionApi: () => vi.fn(), useAddReactionApi: () => vi.fn(),
  usePinMessage: () => ({ mutate: vi.fn() }), useUnpinMessage: () => ({ mutate: vi.fn() }),
  useToggleMark: () => vi.fn(),
  useCreateThread: () => ({ mutateAsync: vi.fn() }), useUploadFile: () => ({ mutateAsync: vi.fn() }),
}))

type Observer = { callback: IntersectionObserverCallback; observed: Set<Element>; disconnected: boolean }
let observers: Observer[]
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
let mounted: ReturnType<typeof render> | undefined
let releaseTransport: () => void
let visibility: DocumentVisibilityState
type Kind = "channel" | "post" | "thread"
const viewer = { id: "viewer", name: "Viewer", email: "viewer@example.test", avatar: "V" }
let latest: {
  feed: ReturnType<typeof useChannelMessageFeed>
  channel: ReturnType<typeof useMessageChannelController>
}

function Conversation({ channelId, kind, anchorMessageId, fullFooter }: { channelId: string; kind: Kind; anchorMessageId: string | null; fullFooter?: boolean }) {
  const feed = useChannelMessageFeed({ channelId, serverId: "s1", viewerUserId: viewer.id, anchorMessageId })
  const channel = useMessageChannelController({ channelId, serverId: "s1", serverParam: "s1", channelName: "Conversation",
    viewer, anchorMessageId, feed, uiHandlers: {}, onOpenThread: () => {}, onOpenPinned: () => {}, resolveUserName: id => id,
    forumParentChannelId: kind === "post" ? "parent" : undefined,
  })
  const props = { channel: "Conversation", messages: feed.messages,
    loading: feed.isLoading, initialLoadError: feed.initialLoadError,
    newBoundary: feed.newBoundary, latestSeq: feed.latestSeq, retiredNewTargetId: feed.retiredNewTargetId,
    onLoadNewTarget: feed.loadNewTarget, onReadNewBoundary: feed.readNewBoundary,
    newDividerBefore: feed.newDividerBefore, initialPositionMessageId: feed.initialPositionMessageId,
    initialScrollReady: feed.initialDisplayReady,
    preserveInitialPresentation: feed.preserveInitialPresentation,
    positionEntry: feed.positionEntry, positionScope: feed.positionScope,
    positionDataState: feed.positionDataState, messageWindow: feed.messageWindow, presentRequest: feed.presentRequest,
    scrollToMessageId: channel.scrollTargetId, onScrollTargetConsumed: channel.consumeScrollTarget,
    hasMore: feed.hasMoreOlder, hasMoreNewer: feed.hasMoreNewer, historyStartKnown: feed.historyStartKnown,
    isFetching: feed.isFetching, isFetchingOlder: feed.isFetchingOlder, isFetchingNewer: feed.isFetchingNewer,
    onLoadOlder: feed.fetchOlder, onLoadNewer: feed.fetchNewer, onJumpToPresent: feed.jumpToPresent,
    onScrollRoot: feed.setScrollRootEl, presentVersion: feed.presentVersion, localSubmitVersion: channel.localSubmitVersion,
    variant: "channel" as const, viewerUserId: viewer.id, onOpenThread: () => {},
  }
  useLayoutEffect(() => { latest = { feed, channel } }, [feed, channel])
  return <div data-slot="community-conversation-surface">
    {fullFooter ? <ConversationFooterSlotProvider>
      <MessageList {...props} />
      <ConversationFooterShell><div /></ConversationFooterShell>
    </ConversationFooterSlotProvider> : <MessageList {...props} />}
  </div>
}

function entry(kind: Kind, channelId = "c1", ownTail = false) {
  const value = conversationEntryFixture()
  const prefix = channelId === "c1" ? "m" : "b"
  value.channelId = channelId
  value.channel = { ...value.channel, id: channelId, type: kind === "channel" ? "text" : "thread", messageCount: 42,
    parentChannelId: kind === "channel" ? null : "parent", parentMessageId: kind === "channel" ? null : "opener" }
  if (kind !== "channel") value.parent = { ...value.channel, id: "parent", type: kind === "post" ? "forum" : "text", parentChannelId: null, parentMessageId: null }
  value.access = { ...value.access, channelId, canCreateDiscussion: kind === "channel" }
  value.messages = Array.from({ length: 42 }, (_, index) => ({ ...value.messages[0], channelId,
    id: `${prefix}${index + 1}`, seq: index + 1, authorId: ownTail && index === 41 ? viewer.id : "peer",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString(),
  }))
  value.profiles = messageProfilesFixture(value.messages)
  value.readState = { channelId, lastReadMessageId: `${prefix}30`, lastReadSeq: 30, lastReadAt: value.messages[29].createdAt }
  value.selection = { reason: "tail", anchorMessageId: null }
  value.newBoundary = { afterSeq: 30, target: { id: `${prefix}31`, channelId, seq: 31, authorId: "peer" } }
  value.surfaceReceipt = { channelId, surfaceKind: kind === "channel" ? "channel" : "thread" }
  value.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }
  return value
}

async function setup(kind: Kind, ownTail = false, strict = false, options: {
  cached?: ReturnType<typeof entry>
  latestAttentionSeq?: number
  refresh?: Promise<ReturnType<typeof entry>>
  refreshWindow?: Promise<ReturnType<typeof entry>>
  readPointer?: AccountReadStateSnapshot["readStates"][number]
  initialActive?: boolean
  restored?: boolean
  restoreAfterMount?: boolean
  fullFooter?: boolean
  missingReadPointer?: boolean
} = {}) {
  owner = await createCommunityQueryOwner()
  await seedConversationEntry(owner.client, options.cached ?? entry(kind, "c1", ownTail))
  await seedConversationEntry(owner.client, entry("channel", "c2"))
  let restoreWindow: (() => void) | undefined
  if (options.restored) {
    const restored = readCommunityRestoredCollections({ timestamp: Date.now(), buster: PERSIST_BUSTER, clientState: dehydrate(owner.client) }, "viewer")
    owner.client.removeQueries({ queryKey: communityKeys.channelMessages("c1") })
    owner.client.removeQueries({ queryKey: communityKeys.conversationEntries("c1") })
    if (options.restoreAfterMount) restoreWindow = () => restoreConversationDisplayWindows(owner.registry, {
      ...restored, messages: restored.messages && { ...restored.messages, updatedAt: Date.now() - 60_000 },
    })
    else restoreConversationDisplayWindows(owner.registry, restored)
  }
  if (options.missingReadPointer) {
    await writeCommunityCollectionChanges(owner.registry, "readStates", [], ["c1"])
    await writeCommunityCollectionChanges(owner.registry, "readStateClock", [], ["account"])
    expect(currentConversationReadState(owner.client, "c1")).toBeUndefined()
  }
  if (options.readPointer) ingestReadStateSnapshot(owner.registry, { revision: 2, readStates: [options.readPointer] })
  if (options.latestAttentionSeq) await publishAccountAttentionSnapshot(owner.client, {
    snapshot: { resources: resourceBundleFixture(), scopes: [{ scopeId: "c1", channelId: "c1", serverId: "s1", ordinaryUnread: true,
      lastUnreadSeq: options.latestAttentionSeq, lastAttentionSeq: null, attentionCount: 0 }],
    items: [], limit: 100, truncated: false,
    included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } },
    proof: { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined },
  })
  let finishPut!: (value: unknown) => void
  let finishCanonical!: (value: unknown) => void
  const put = new Promise(resolve => { finishPut = resolve })
  const canonicalTransport = new Promise(resolve => { finishCanonical = resolve })
  releaseTransport = () => { finishPut({ changed: true, revision: 6, targetSeq: 42 }); finishCanonical({ revision: 6, readStates: [] }) }
  load.mockImplementation((url: string) => {
    if (url.startsWith("/api/community/channels/c1/messages?") && new URL(url, "https://test.invalid").searchParams.has("entry") && options.refresh) return options.refresh
    if (url === "/api/community/channels/c1/messages" && options.refreshWindow) return options.refreshWindow.then(value => ({
      ...value.page, profiles: value.profiles, messages: value.messages,
    }))
    if (url.startsWith("/api/community/channels/c1/messages?since=") && options.refresh) return options.refresh.then(value => ({
      ...value.page, profiles: value.profiles, messages: value.messages.filter(message => message.seq > 1),
    }))
    if (options.restored && options.refresh && new URL(url, "https://test.invalid").searchParams.has("cursor")) return options.refresh.then(value => ({
      ...value.page, messages: [], profiles: [], hasMoreOlder: false, olderCursor: null,
    }))
    if (url.includes("/messages?") && new URL(url, "https://test.invalid").searchParams.has("entry")) {
      const requested = new URL(url, "https://test.invalid")
      const id = requested.pathname.split("/").at(-2)!
      const packet = entry(id === "c1" ? kind : "channel", id, ownTail && id === "c1")
      const current = currentConversationReadState(owner.client, id)
      if (current) {
        packet.readState = { channelId: id, lastReadMessageId: current.lastReadMessageId, lastReadSeq: current.lastReadSeq, lastReadAt: current.lastReadAt }
        packet.readStateRevision = current.observedRevision ?? packet.readStateRevision
      }
      const afterSeq = Number(requested.searchParams.get("newAfterSeq") ?? packet.readState.lastReadSeq)
      const first = packet.messages.find(message => message.seq > afterSeq && message.authorId !== viewer.id)
      packet.newBoundary = { afterSeq, target: first ? { id: first.id, channelId: id, seq: first.seq, authorId: first.authorId } : null }
      const anchor = requested.searchParams.get("anchor")
      if (anchor) packet.selection = { reason: "explicit_anchor", anchorMessageId: anchor }
      return Promise.resolve(packet)
    }
    if (url.endsWith("/read")) return put
    if (url === "/api/community/users/me/read-state") return canonicalTransport
    if (url === "/api/community/users/me/attention") return Promise.resolve({ scopes: [], items: [], limit: 100, truncated: false })
    throw new Error(`Unexpected entry-position transport: ${url}`)
  })
  let channelId = "c1", active = options.initialActive ?? true, anchorMessageId: string | null = null
  let restoring = options.restoreAfterMount ?? false
  const navigation = { entryIntent: { href: "/c/channels/s1/c1" } as { href: string; resume?: boolean } }
  const content = () => <QueryClientProvider client={owner.client}><IsRestoringProvider value={restoring}><CommunityDbProvider registry={owner.registry}>
    <CurrentUserProvider initialUser={viewer}>
      <CommunityRouteContext value={{ navigation } as never}>
        <ConversationActivityContext value={active}>
          <Conversation key={channelId} channelId={channelId} kind={channelId === "c1" ? kind : "channel"} anchorMessageId={anchorMessageId} fullFooter={options.fullFooter} />
        </ConversationActivityContext>
      </CommunityRouteContext>
    </CurrentUserProvider>
  </CommunityDbProvider></IsRestoringProvider></QueryClientProvider>
  const element = () => strict ? <StrictMode>{content()}</StrictMode> : content()
  mounted = render(element())
  resize()
  await act(async () => {})
  const root = () => mounted!.getByTestId("community-message-scroller")
  const visible = (id: string) => {
    const row = root().querySelector<HTMLElement>(`[data-msg-id="${id}"]`)
    if (!row) return false
    const rect = row.getBoundingClientRect(), viewport = root().getBoundingClientRect()
    return rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom
  }
  const navigate = async (href: string, options: { resume?: boolean; active?: boolean; retainParent?: boolean; settle?: boolean } = {}) => {
    navigationMock.href = href
    navigation.entryIntent = { href, ...(options.resume ? { resume: true } : {}) }
    active = options.active ?? true
    if (!options.retainParent) channelId = href.split("?")[0].split("/").at(-1)!
    anchorMessageId = new URLSearchParams(href.split("?")[1]).get("msg")
    mounted!.rerender(element())
    if (options.settle !== false) resize()
    await act(async () => {})
  }
  const canonical = async (seq: number) => {
    await act(async () => ingestReadStateSnapshot(owner.registry, { revision: seq, readStates: [
      { channelId: "c1", lastReadMessageId: `m${seq}`, lastReadSeq: seq, lastReadAt: "later" },
    ] }))
    resize()
  }
  const tail = async () => {
    fireEvent.wheel(root(), { deltaY: 20 })
    act(() => root().scrollTo({ top: root().scrollHeight }))
    resize()
    await act(async () => {})
    expect(visible("m42")).toBe(true)
  }
  const setActivity = async (next: boolean) => {
    active = next
    mounted!.rerender(element())
    resize()
    await act(async () => {})
  }
  const publishRestoredWindow = async () => {
    await act(async () => {
      restoreWindow?.()
      restoring = false
      mounted!.rerender(element())
      await vi.advanceTimersByTimeAsync(0)
    })
    resize()
    await act(async () => {})
  }
  return { root, visible, navigate, canonical, tail, setActivity, publishRestoredWindow }
}

function intersection(row: Element, ratio = 1): IntersectionObserverEntry {
  return { target: row, isIntersecting: ratio > 0, intersectionRatio: ratio,
    boundingClientRect: row.getBoundingClientRect(), intersectionRect: row.getBoundingClientRect(), rootBounds: null, time: performance.now() }
}
function boundObserver(row: Element) {
  const observer = observers.findLast(item => !item.disconnected && item.observed.has(row))
  expect(observer).toBeDefined()
  return observer!
}
const messageOrReadRequests = () => load.mock.calls.filter(([url]) => String(url).includes("/messages") || String(url).endsWith("/read"))
const latestRequests = () => load.mock.calls.filter(([url]) => url === "/api/community/channels/c1/messages")
function deferredEntry() {
  let resolve!: (value: ReturnType<typeof entry>) => void
  const promise = new Promise<ReturnType<typeof entry>>(done => { resolve = done })
  return { promise, resolve }
}
async function setupFooterJump(missingReadPointer = false) {
  const fresh = entry("channel")
  fresh.readState = { channelId: "c1", lastReadMessageId: "m1", lastReadSeq: 1, lastReadAt: fresh.messages[0].createdAt }
  fresh.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
  const cached = { ...fresh, channel: { ...fresh.channel, messageCount: 1 }, messages: fresh.messages.slice(0, 1),
    page: { ...fresh.page, latestSeq: 1 }, newBoundary: { afterSeq: 1, target: null } }
  const landing = deferredEntry(), tail = deferredEntry()
  const view = await setup("channel", false, false, { cached, latestAttentionSeq: 42, refresh: landing.promise,
    refreshWindow: tail.promise, restored: true, fullFooter: true, missingReadPointer })
  expect(view.visible("m1")).toBe(true)
  expect(view.root()).toHaveAttribute("data-pagination-enabled", "false")
  expect(view.root().querySelector("[data-message-list-content]")).toHaveAttribute("data-read-position-ready", "false")
  expect(latest.feed.readSnapshotFetching).toBe(true)
  expect(load.mock.calls.filter(([url]) => String(url).includes("/messages") && !String(url).includes("entry=1"))).toEqual([])
  expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
  const click = async () => {
    fireEvent.click(mounted!.getByTestId("community-scroll-to-present"))
    await act(async () => {})
  }
  const finish = async () => { await act(async () => { landing.resolve(fresh); tail.resolve(fresh); await vi.advanceTimersByTimeAsync(0) }) }
  return { ...view, fresh, landing, tail, click, finish }
}

beforeEach(() => {
  installMessageScrollFixture()
  observers = []
  mounted = undefined
  load.mockReset()
  navigationMock.href = "/c/channels/s1/c1"
  visibility = "visible"
  navigationMock.replace.mockImplementation((href: string) => { navigationMock.href = href })
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  vi.stubGlobal("IntersectionObserver", class {
    record: Observer
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, observed: new Set(), disconnected: false }; observers.push(this.record) }
    observe(node: Element) { this.record.observed.add(node) }
    unobserve(node: Element) { this.record.observed.delete(node) }
    disconnect() { this.record.disconnected = true; this.record.observed.clear() }
    takeRecords() { return [] }
  })
})
afterEach(async () => {
  mounted?.unmount()
  if (owner) { disposeReadCoordinator(owner.client); disposeAccountReadStateReconciliation(owner.client) }
  await act(async () => releaseTransport?.())
  restoreMessageScrollFixture()
})

describe("conversation entry positioning through real reading owners", () => {
  it("reveals an old restored thread window after mount without launching a second freshness owner while entry is held", async () => {
    const fresh = entry("thread")
    fresh.messages = fresh.messages.slice(0, 1)
    fresh.channel.messageCount = 1
    fresh.page.latestSeq = 1
    fresh.readState = { channelId: "c1", lastReadMessageId: "m1", lastReadSeq: 1, lastReadAt: fresh.messages[0].createdAt }
    fresh.newBoundary = { afterSeq: 1, target: null }
    const landing = deferredEntry()
    const view = await setup("thread", false, false, { cached: fresh, refresh: landing.promise, refreshWindow: Promise.resolve(fresh), restored: true, restoreAfterMount: true })
    try {
      expect(latest.feed.messages).toEqual([])
      expect(load.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(0)
      await view.publishRestoredWindow()
      expect(view.visible("m1")).toBe(true)
      expect(latest.feed.messages.map(message => message.id)).toEqual(["m1"])
      expect(latest.feed.readSnapshotFetching).toBe(true)
      expect(view.root()).toHaveAttribute("data-pagination-enabled", "false")
      expect(view.root().querySelector("[data-message-list-content]")).toHaveAttribute("data-read-position-ready", "false")
      expect(load.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(1)
      expect(latestRequests()).toHaveLength(0)
      await act(async () => { landing.resolve(fresh); await vi.advanceTimersByTimeAsync(500) })
      resize()
      expect(latest.feed.historyStartKnown).toBe(true)
      expect(load.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(1)
      expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    } finally { await act(async () => landing.resolve(fresh)) }
  })

  it("admits one real footer Jump with a cached pointer, retains the pending window and accepts its current tail", async () => {
    const view = await setupFooterJump()
    try {
      const window = latest.feed.messageWindow
      const pointer = currentConversationReadState(owner.client, "c1")
      await view.click()
      const request = latest.feed.presentRequest
      expect(request?.accepted).toBe(true)
      if (!request?.accepted) throw new Error("The real footer did not admit Jump")
      expect(latestRequests()).toHaveLength(1)
      await view.click()
      expect(latestRequests()).toHaveLength(1)
      expect(latest.feed.messageWindow).toBe(window)
      expect(latest.feed.messages.map(message => message.id)).toEqual(["m1"])
      expect(currentConversationReadState(owner.client, "c1")).toBe(pointer)
      expect(latest.feed.presentVersion).toBe(0)
      await act(async () => { view.tail.resolve(view.fresh); await request.completed; await vi.advanceTimersByTimeAsync(0) })
      resize()
      const result = await request.completed
      expect(result.status).toBe("success")
      if (result.status !== "success") throw new Error("Current Jump did not complete")
      expect(result.windowState?.(latest.feed.messageWindow)).toBe("ready")
      expect(latest.feed.messages.map(message => message.id)).toEqual(view.fresh.messages.map(message => message.id))
      expect(latest.feed.presentVersion).toBe(1)
      expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(1)
      expect(latestRequests()).toHaveLength(1)
      expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    } finally { await view.finish() }
  })

  it("does not admit the visible real footer Jump without either a read row or an account clock", async () => {
    const view = await setupFooterJump(true)
    try {
      await view.click()
      expect(latestRequests()).toEqual([])
      expect(latest.feed.presentRequest).toBeNull()
      expect(latest.feed.messages.map(message => message.id)).toEqual(["m1"])
      expect(currentConversationReadState(owner.client, "c1")).toBeUndefined()
      expect(view.visible("m1")).toBe(true)
    } finally { await view.finish() }
  })

  it("retires an actual footer Jump after navigation without moving the next conversation", async () => {
    const view = await setupFooterJump()
    try {
      await view.click()
      const request = latest.feed.presentRequest
      if (!request?.accepted) throw new Error("The real footer did not admit Jump")
      await view.navigate("/c/channels/s1/c2")
      const window = latest.feed.messageWindow, position = view.root().scrollTop
      const ids = latest.feed.messages.map(message => message.id)
      const pointer = currentConversationReadState(owner.client, "c2")
      await act(async () => { view.tail.resolve(view.fresh); await request.completed; await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(await request.completed).toEqual({ status: "retired" })
      expect(latest.feed.messageWindow).toBe(window)
      expect(latest.feed.messages.map(message => message.id)).toEqual(ids)
      expect(ids.every(id => id.startsWith("b"))).toBe(true)
      expect(currentConversationReadState(owner.client, "c2")).toBe(pointer)
      expect(view.root().scrollTop).toBe(position)
      expect(latest.feed.presentVersion).toBe(0)
      expect(latestRequests()).toHaveLength(1)
    } finally { await view.finish() }
  })

  it("rejects an actual footer Jump response after channel access retires its generation", async () => {
    const view = await setupFooterJump()
    try {
      await view.click()
      const request = latest.feed.presentRequest
      if (!request?.accepted) throw new Error("The real footer did not admit Jump")
      await act(async () => owner.runtime.ws.actions.revokeChannelAccess("s1", "c1"))
      await act(async () => { view.tail.resolve(view.fresh); await request.completed; await vi.advanceTimersByTimeAsync(0) })
      resize()
      expect(await request.completed).toEqual({ status: "retired" })
      expect(owner.registry.collections.messages.has("m42")).toBe(false)
      expect(latest.feed.messages.some(message => message.id === "m42")).toBe(false)
      expect(latest.feed.presentVersion).toBe(0)
      expect(latestRequests()).toHaveLength(1)
      expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    } finally { await view.finish() }
  })

  it("uses the fresh entry's complete oldest boundary before automatic pagination can reread a restored one-message thread", async () => {
    const fresh = entry("thread")
    fresh.messages = fresh.messages.slice(0, 1)
    fresh.channel.messageCount = 1
    fresh.page.latestSeq = 1
    fresh.readState = { channelId: "c1", lastReadMessageId: "m1", lastReadSeq: 1, lastReadAt: fresh.messages[0].createdAt }
    fresh.newBoundary = { afterSeq: 1, target: null }
    const landing = deferredEntry()
    const view = await setup("thread", false, false, { cached: fresh, refresh: landing.promise, restored: true })
    try {
      expect(view.visible("m1")).toBe(true)
      expect(view.root()).toHaveAttribute("data-pagination-enabled", "false")
      expect(latest.feed.hasMoreOlder).toBe(true)
      await act(async () => { landing.resolve(fresh); await vi.advanceTimersByTimeAsync(500) })
      resize()
      expect(latest.feed.hasMoreOlder).toBe(false)
      expect(latest.feed.historyStartKnown).toBe(true)
      expect(load.mock.calls.filter(([url]) => String(url).includes("/messages"))).toHaveLength(1)
      expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    } finally { await act(async () => landing.resolve(fresh)) }
  })

  it.each(["inactive", "document-hidden"])("opens the real read transport after a laid-out short entry becomes visible from %s", async mode => {
    scrollFixture.firstPrefix = 120
    if (mode === "document-hidden") visibility = "hidden"
    const cached = entry("channel")
    cached.messages = cached.messages.slice(0, 1)
    cached.channel.messageCount = 1
    cached.page.latestSeq = 1
    cached.readState = { channelId: "c1", lastReadMessageId: null, lastReadSeq: 0, lastReadAt: null }
    cached.newBoundary = { afterSeq: 0, target: { id: "m1", channelId: "c1", seq: 1, authorId: "peer" } }
    cached.selection = { reason: "tail", anchorMessageId: null }
    const view = await setup("channel", false, false, { cached, initialActive: mode !== "inactive" })
    expect(view.root().querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "false")
    expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    if (mode === "document-hidden") {
      visibility = "visible"
      fireEvent(document, new Event("visibilitychange"))
      resize()
    } else await view.setActivity(true)
    expect(view.root().querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "true")
    const row = view.root().querySelector('[data-msg-id="m1"]')!
    const observer = boundObserver(row)
    act(() => observer.callback([intersection(row)], {} as IntersectionObserver))
    expect(getReadCoordinator(owner.client, viewer.id).state.get().scopes.get("timeline:c1")?.accepted?.intent.seq).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(READ_COORDINATOR_DEBOUNCE_MS))
    expect(load).toHaveBeenCalledWith("/api/community/channels/c1/read", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ lastReadMessageId: "m1" }),
    }))
  })

  it("keeps a precommitted entry unread while inactive and admits its real observer on first activation", async () => {
    const view = await setup("channel", false, false, { initialActive: false })
    const entry = latest.feed.positionEntry
    expect(view.root().querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "false")
    expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    await view.setActivity(true)
    expect(latest.feed.positionEntry).toBe(entry)
    expect(view.visible("m42")).toBe(true)
    expect(view.root().querySelector('[data-read-position-ready]')).toHaveAttribute("data-read-position-ready", "true")
    const row = view.root().querySelector('[data-msg-id="m42"]')!
    const observer = boundObserver(row)
    act(() => observer.callback([intersection(row)], {} as IntersectionObserver))
    expect(getReadCoordinator(owner.client, viewer.id).state.get().scopes.get("timeline:c1")?.accepted?.intent.seq).toBe(42)
  })

  it.each([{ delayCanonical: false, previousTail: false, restored: false }, { delayCanonical: true, previousTail: false, restored: false }, { delayCanonical: false, previousTail: true, restored: false }, { delayCanonical: false, previousTail: false, restored: true }])("reveals the cached ordinary window before network completion without granting reading, delayed canonical=$delayCanonical, previous tail=$previousTail, restored=$restored", async ({ delayCanonical, previousTail, restored }) => {
    const fresh = entry("channel")
    fresh.messages = fresh.messages.slice(0, 13)
    fresh.channel.messageCount = 13
    const readPointer = { channelId: "c1", lastReadMessageId: "m1", lastReadSeq: 1, lastReadAt: fresh.messages[0].createdAt }
    fresh.readState = readPointer
    fresh.selection = { reason: "tail", anchorMessageId: null }
    fresh.newBoundary = { afterSeq: 1, target: { id: "m2", channelId: "c1", seq: 2, authorId: "peer" } }
    fresh.readStateRevision = 2
    fresh.page.latestSeq = 13
    const cached = { ...fresh, channel: { ...fresh.channel, messageCount: 1 }, messages: fresh.messages.slice(0, 1), page: { ...fresh.page, latestSeq: 1 }, newBoundary: { afterSeq: 1, target: null } as typeof fresh.newBoundary }
    if (previousTail) {
      cached.readState = { channelId: "c1", lastReadMessageId: null, lastReadSeq: 0, lastReadAt: null }
      cached.readStateRevision = 1
      cached.newBoundary = { afterSeq: 0, target: { id: "m1", channelId: "c1", seq: 1, authorId: "peer" } }
      cached.selection = { reason: "tail", anchorMessageId: null }
    }
    let finishRefresh!: (value: typeof fresh) => void
    const refresh = new Promise<typeof fresh>(resolve => { finishRefresh = resolve })
    let finishWindow!: (value: typeof fresh) => void
    const refreshWindow = new Promise<typeof fresh>(resolve => { finishWindow = resolve })
    const view = await setup("channel", false, false, { cached, latestAttentionSeq: 13, refresh, restored,
      ...(previousTail ? { readPointer, refreshWindow } : {}),
    })
    const nativeWrite = owner.registry.collections.messages.utils.writeBatch.bind(owner.registry.collections.messages.utils)
    const publications: Array<() => Promise<void>> = []
    const delayed = delayCanonical ? vi.spyOn(owner.registry.collections.messages.utils, "writeBatch").mockImplementation(callback => (
      new Promise<void>((resolve, reject) => { publications.push(() => nativeWrite(callback).then(resolve, reject)) })
    )) : null
    const publish = async () => {
      delayed?.mockRestore()
      await Promise.all(publications.splice(0).map(commit => commit()))
    }
    try {
      expect(latest.feed.messages.map(message => message.id)).toEqual(["m1"])
      expect(view.visible("m1")).toBe(true)
      expect(view.root()).toHaveAttribute("aria-busy", "false")
      expect(view.root().querySelector("[data-message-list-content]")).toHaveAttribute("data-initial-position-phase", "revealed")
      expect(latest.feed.isFetching).toBe(true)
      expect(latest.feed.readSnapshotFetching).toBe(true)
      expect(latest.feed.readSnapshot?.lastReadSeq).toBe(1)
      expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
      if (restored) {
        expect(view.root()).toHaveAttribute("data-pagination-enabled", "false")
        expect(view.root().querySelector("[data-message-list-content]")).toHaveAttribute("data-read-position-ready", "false")
        expect(load.mock.calls.filter(([url]) => String(url).includes("/messages") && !String(url).includes("entry=1"))).toEqual([])
      }
      const initialReadReady = view.root().querySelector("[data-message-list-content]")!.getAttribute("data-read-position-ready") ?? "false"
      await act(async () => { finishRefresh(fresh); await vi.advanceTimersByTimeAsync(0) })
      resize()
      if (delayCanonical) {
        await act(async () => vi.advanceTimersByTimeAsync(6000))
        resize()
        expect({ latestSeq: latest.feed.latestSeq, messages: latest.feed.messages.map(message => message.id),
          fetching: latest.feed.isFetching, readSnapshotFetching: latest.feed.readSnapshotFetching,
          readReady: view.root().querySelector("[data-message-list-content]")!.getAttribute("data-read-position-ready") ?? "false",
        }).toEqual({ latestSeq: 1, messages: ["m1"], fetching: true, readSnapshotFetching: true, readReady: "false" })
        await act(async () => { await publish(); await vi.advanceTimersByTimeAsync(0) })
        resize()
      }
      expect(latest.feed.error).toBeNull()
      expect(latest.feed.messages).toHaveLength(13)
      const marker = view.root().querySelector("[data-new-divider]")!.getBoundingClientRect()
      const viewport = view.root().getBoundingClientRect()
      expect({ initialReadReady, newInViewport: marker.bottom > viewport.top && marker.top < viewport.bottom,
        lastInViewport: view.visible("m13"), readReadyAfter: view.root().querySelector("[data-message-list-content]")!.getAttribute("data-read-position-ready"),
      }).toEqual({ initialReadReady: "false", newInViewport: false, lastInViewport: true, readReadyAfter: "true" })
      expect(latest.feed.readSnapshot?.lastReadSeq).toBe(1)
      expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
    } finally {
      await act(async () => { finishRefresh(fresh); finishWindow(fresh); await publish(); await vi.advanceTimersByTimeAsync(0) })
    }
  })

  it("uses normal bottom entry after a stale cached message-owner remount", async () => {
    const view = await setup("channel", true)
    await view.tail()
    const oldRoot = view.root()
    fireEvent.wheel(oldRoot, { deltaY: -600 })
    act(() => oldRoot.scrollTo({ top: oldRoot.scrollHeight - oldRoot.clientHeight - 600 }))
    resize()
    const offset = oldRoot.scrollTop
    expect(oldRoot.scrollHeight - oldRoot.clientHeight - offset).toBe(600)
    await view.navigate("/c/channels/s1/c2")
    expect(oldRoot.isConnected).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    const previousLoad = load.getMockImplementation()!
    load.mockImplementation((url: string, options: unknown) => url.includes("/messages?entry=1") ? new Promise(() => {}) : previousLoad(url, options))
    await view.navigate("/c/channels/s1/c1")
    expect(load.mock.calls.some(([url]) => url.includes("/messages?entry=1"))).toBe(true)
    expect(view.root().scrollTop).not.toBeCloseTo(offset, 0)
    expect(view.visible("m42")).toBe(true)
    expect(latest.feed.newDividerBefore).toBe("m31")
    expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(30)
    expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
  })

  it.each([
    { kind: "channel", strict: false }, { kind: "post", strict: false },
    { kind: "thread", strict: false }, { kind: "channel", strict: true },
  ] as const)("positions a fresh retained $kind entry once while semantic resume keeps its viewport (StrictMode=$strict)", async ({ kind, strict }) => {
    const view = await setup(kind, false, strict)
    const originalRoot = view.root(), originalWindow = latest.feed.readSnapshot
    expect(view.visible("m42")).toBe(true)
    act(() => latest.channel.jumpToSeq(10))
    resize()
    expect(view.visible("m10")).toBe(true)
    const offset = originalRoot.scrollTop
    await view.navigate("/c/channels/s1/child", { active: false, retainParent: true })
    await view.canonical(40)
    await view.navigate("/c/channels/s1/c1", { resume: true })
    expect(view.root()).toBe(originalRoot)
    expect(latest.feed.readSnapshot).toBe(originalWindow)
    expect(view.root().scrollTop).toBe(offset)
    await view.navigate("/c/channels/s1/c1")
    expect(latest.feed.readSnapshot?.lastReadSeq).toBe(40)
    expect(view.root()).toBe(originalRoot)
    expect(view.visible("m42")).toBe(true)
    const landed = view.root().scrollTop
    await view.canonical(42)
    expect(latest.feed.readSnapshot?.lastReadSeq).toBe(40)
    expect(view.root().scrollTop).toBe(landed)
    expect(messageOrReadRequests().filter(([, options]) => options?.method === "PUT")).toEqual([])
    expect(messageOrReadRequests().filter(([url]) => String(url).includes("entry=1"))).toHaveLength(1)
  })

  it("adopts a new same-pane msg after target consumption, including a repeated target and an independent seq", async () => {
    const view = await setup("channel"), root = view.root()
    await view.navigate("/c/channels/s1/c1?msg=m5")
    expect(view.visible("m5")).toBe(true)
    expect(latest.channel.scrollTargetId).toBeNull()
    const consumePrevious = latest.channel.consumeScrollTarget
    act(() => latest.channel.jumpToSeq(20))
    resize()
    expect(view.visible("m20")).toBe(true)
    await act(async () => {})
    const previousRow = root.querySelector('[data-msg-id="m20"]')!, previousObserver = boundObserver(previousRow)
    await view.navigate("/c/channels/s1/c1?msg=m5", { settle: false })
    expect(view.root().querySelector('[data-message-list-content]')?.getAttribute("data-read-position-ready")).toBe("false")
    act(() => {
      consumePrevious("m5")
      previousObserver.callback([intersection(previousRow)], {} as IntersectionObserver)
    })
    expect(latest.channel.scrollTargetId).toBe("m5")
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    resize()
    expect(view.visible("m5")).toBe(true)
    await view.navigate("/c/channels/s1/c1?seq=12")
    resize()
    expect(view.visible("m12")).toBe(true)
    expect(view.root()).toBe(root)
  })

  it.each([false, true])("cancels a target lost by the current ready query window without granting its old observer a read (StrictMode=%s)", async strict => {
    const view = await setup("channel", false, strict), root = view.root()
    const previousRow = root.querySelector('[data-msg-id="m42"]')!
    const previousObserver = boundObserver(previousRow)
    const explicit = entry("channel")
    explicit.selection = { reason: "explicit_anchor", anchorMessageId: "m5" }
    await act(async () => { await seedConversationEntry(owner.client, explicit, {
      channelId: "c1", serverId: "s1", anchorMessageId: "m5",
    }) })
    await view.navigate("/c/channels/s1/c1?msg=m5", { settle: false })
    const positionEntry = latest.feed.positionEntry
    expect(latest.channel.scrollTargetId).toBe("m5")
    expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "true")
    const covered = latest.feed.messageWindow!
    const query = owner.client.getQueryCache().getAll().find(query => query.state.data === covered)!
    await act(async () => {
      owner.client.setQueryData(query.queryKey, {
        ...covered, pages: covered.pages.map(page => ({ ...page, messages: page.messages.filter(message => message.id !== "m5") })),
      })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(latest.feed.positionDataState).toBe("ready")
    expect(latest.feed.messages.some(message => message.id === "m5")).toBe(false)
    expect(latest.feed.positionEntry).toBe(positionEntry)
    resize()
    expect(view.root()).toBe(root)
    expect(latest.channel.scrollTargetId).toBeNull()
    expect(root.querySelector("[data-message-list-content]")).toHaveAttribute("aria-hidden", "false")
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    await act(async () => {
      owner.client.setQueryData(query.queryKey, covered)
      previousObserver.callback([intersection(previousRow)], {} as IntersectionObserver)
      await vi.advanceTimersByTimeAsync(20000)
    })
    resize()
    expect(latest.feed.positionEntry).toBe(positionEntry)
    expect(latest.channel.scrollTargetId).toBeNull()
    expect(view.visible("m5")).toBe(false)
    expect(root.querySelector("[data-read-position-ready]")).toHaveAttribute("data-read-position-ready", "false")
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    expect(load.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false)
  })

  it.each(["channel", "post", "thread"] as const)("returns to observer-admitted %s reading before PUT confirmation or canonical publication", async kind => {
    const view = await setup(kind)
    await view.tail()
    const row = view.root().querySelector('[data-msg-id="m42"]')!
    const observer = boundObserver(row)
    act(() => observer.callback([intersection(row)], {} as IntersectionObserver))
    expect(getReadCoordinator(owner.client, viewer.id).state.get().scopes.get("timeline:c1")?.accepted?.intent.seq).toBe(42)
    expect(getLocalReadingPosition(owner.client, "c1")?.seq).toBe(42)
    await view.navigate("/c/channels/s1/c2")
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(load).toHaveBeenCalledWith("/api/community/channels/c1/read", expect.objectContaining({ method: "PUT", body: JSON.stringify({ lastReadMessageId: "m42" }) }))
    await view.navigate("/c/channels/s1/c1")
    expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(30)
    expect(latest.feed.readSnapshot?.lastReadSeq).toBe(30)
    expect(latest.feed.newDividerBefore).toBe("m31")
    expect(view.visible("m42")).toBe(true)
    expect(load.mock.calls.some(([url]) => String(url).includes("messages"))).toBe(false)
  })

  it("uses normal entry without promoting a retired observation and freezes late publication", async () => {
    const view = await setup("channel")
    await view.tail()
    const row = view.root().querySelector('[data-msg-id="m42"]')!, observer = boundObserver(row), record = intersection(row)
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    await view.navigate("/c/channels/s1/c2")
    act(() => observer.callback([record], {} as IntersectionObserver))
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    await view.navigate("/c/channels/s1/c1")
    expect(view.visible("m31")).toBe(false)
    expect(view.visible("m42")).toBe(true)
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    const offset = view.root().scrollTop
    await view.canonical(42)
    expect(latest.feed.readSnapshot?.lastReadSeq).toBe(30)
    expect(view.root().scrollTop).toBe(offset)
    expect(messageOrReadRequests()).toEqual([])
  })

  it.each(["threshold", "inert", "document-hidden", "own-author"] as const)("uses normal entry without turning a rejected %s observation into a reading cursor", async control => {
    const view = await setup("channel", control === "own-author")
    await view.tail()
    const row = view.root().querySelector('[data-msg-id="m42"]')!, observer = boundObserver(row)
    if (control === "inert") view.root().querySelector('[data-message-list-content]')!.setAttribute("inert", "")
    if (control === "document-hidden") visibility = "hidden"
    act(() => observer.callback([intersection(row, control === "threshold" ? 0.19 : 1)], {} as IntersectionObserver))
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    visibility = "visible"
    await view.navigate("/c/channels/s1/c2")
    await view.navigate("/c/channels/s1/c1")
    expect(view.visible("m31")).toBe(false)
    expect(view.visible("m42")).toBe(true)
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    expect(currentConversationReadState(owner.client, "c1")?.lastReadSeq).toBe(30)
    expect(messageOrReadRequests()).toEqual([])
  })
})
