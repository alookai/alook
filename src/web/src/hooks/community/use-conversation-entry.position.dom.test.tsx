import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StrictMode, useLayoutEffect } from "react"
import { useChannelMessageFeed } from "./use-channel-message-feed"
import { useMessageChannelController } from "@/components/community/messages/message-channel-controller-state"
import { MessageList } from "@/components/community/messages/message-list"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { ConversationActivityContext } from "@/contexts/community/conversation-activity"
import { QueryClientProvider } from "@tanstack/react-query"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize } from "@/test/message-scroll-fixture"
import { ingestReadStateSnapshot } from "@/lib/community-db/sync"
import { currentConversationReadState } from "@/lib/community/conversation-entry"
import { disposeReadCoordinator, getLocalReadingPosition, getReadCoordinator } from "./read-coordinator"
import { disposeAccountReadStateReconciliation } from "./community-ws/read-state-reconciliation"

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
  useToggleMark: () => vi.fn(), useEditMessage: () => ({ mutate: vi.fn() }),
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

function Conversation({ channelId, kind, anchorMessageId }: { channelId: string; kind: Kind; anchorMessageId: string | null }) {
  const feed = useChannelMessageFeed({ channelId, serverId: "s1", viewerUserId: viewer.id, isChildChannel: kind !== "channel", anchorMessageId })
  const channel = useMessageChannelController({ channelId, serverId: "s1", serverParam: "s1", channelName: "Conversation",
    viewer, anchorMessageId, feed, uiHandlers: {}, onOpenThread: () => {}, onOpenPinned: () => {}, resolveUserName: id => id,
    forumParentChannelId: kind === "post" ? "parent" : undefined,
  })
  const props = { channel: "Conversation", messages: feed.messages,
    loading: feed.isLoading, initialLoadError: feed.initialLoadError,
    newDividerBefore: feed.newDividerBefore, initialPositionMessageId: feed.initialPositionMessageId,
    initialScrollReady: !feed.readSnapshotFetching && feed.anchorInCache,
    positionEntry: feed.positionEntry,
    scrollToMessageId: channel.scrollTargetId, onScrollTargetConsumed: channel.consumeScrollTarget,
    hasMore: feed.hasMoreOlder, hasMoreNewer: feed.hasMoreNewer, historyStartKnown: feed.historyStartKnown,
    isFetching: feed.isFetching, isFetchingOlder: feed.isFetchingOlder, isFetchingNewer: feed.isFetchingNewer,
    onLoadOlder: feed.fetchOlder, onLoadNewer: feed.fetchNewer, onJumpToPresent: feed.jumpToPresent,
    onScrollRoot: feed.setScrollRootEl, presentVersion: feed.presentVersion, localSubmitVersion: channel.localSubmitVersion,
    variant: "channel" as const, viewerUserId: viewer.id, onOpenThread: () => {},
  }
  useLayoutEffect(() => { latest = { feed, channel } }, [feed, channel])
  return <div data-slot="community-conversation-surface">
    <MessageList {...props} />
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
  value.readState = { channelId, lastReadMessageId: `${prefix}30`, lastReadSeq: 30, lastReadAt: value.messages[29].createdAt }
  value.selection = { reason: "read_pointer", anchorMessageId: `${prefix}30` }
  value.surfaceReceipt = { channelId, surfaceKind: kind === "channel" ? "channel" : "thread" }
  value.page = { olderCursor: null, newerCursor: null, hasMoreOlder: false, hasMoreNewer: false, latestSeq: 42 }
  return value
}

async function setup(kind: Kind, ownTail = false, strict = false) {
  owner = await createCommunityQueryOwner()
  await seedConversationEntry(owner.client, entry(kind, "c1", ownTail))
  await seedConversationEntry(owner.client, entry("channel", "c2"))
  let finishPut!: (value: unknown) => void
  let finishCanonical!: (value: unknown) => void
  const put = new Promise(resolve => { finishPut = resolve })
  const canonicalTransport = new Promise(resolve => { finishCanonical = resolve })
  releaseTransport = () => { finishPut({ changed: true, revision: 6, targetSeq: 42 }); finishCanonical({ revision: 6, readStates: [] }) }
  load.mockImplementation((url: string) => {
    if (url.endsWith("/read")) return put
    if (url === "/api/community/users/me/read-state") return canonicalTransport
    if (url === "/api/community/users/me/attention") return Promise.resolve({ scopes: [], items: [], limit: 100, truncated: false })
    throw new Error(`Unexpected entry-position transport: ${url}`)
  })
  let channelId = "c1", active = true, anchorMessageId: string | null = null
  const navigation = { entryIntent: { href: "/c/channels/s1/c1" } as { href: string; resume?: boolean } }
  const content = () => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>
    <CurrentUserProvider initialUser={viewer}>
      <CommunityRouteContext value={{ navigation } as never}>
        <ConversationActivityContext value={active}>
          <Conversation key={channelId} channelId={channelId} kind={channelId === "c1" ? kind : "channel"} anchorMessageId={anchorMessageId} />
        </ConversationActivityContext>
      </CommunityRouteContext>
    </CurrentUserProvider>
  </CommunityDbProvider></QueryClientProvider>
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
  return { root, visible, navigate, canonical, tail }
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
  it.each([
    { kind: "channel", strict: false }, { kind: "post", strict: false },
    { kind: "thread", strict: false }, { kind: "channel", strict: true },
  ] as const)("positions a fresh retained $kind entry once while semantic resume keeps its viewport (StrictMode=$strict)", async ({ kind, strict }) => {
    const view = await setup(kind, false, strict)
    const originalRoot = view.root(), originalWindow = latest.feed.readSnapshot
    expect(view.visible("m31")).toBe(true)
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
    expect(view.visible("m41")).toBe(true)
    const landed = view.root().scrollTop
    await view.canonical(42)
    expect(latest.feed.readSnapshot?.lastReadSeq).toBe(40)
    expect(view.root().scrollTop).toBe(landed)
    expect(messageOrReadRequests()).toEqual([])
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

  it("keeps canonical landing when return precedes observer admission, ignores the retired callback and freezes late publication", async () => {
    const view = await setup("channel")
    await view.tail()
    const row = view.root().querySelector('[data-msg-id="m42"]')!, observer = boundObserver(row), record = intersection(row)
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    await view.navigate("/c/channels/s1/c2")
    act(() => observer.callback([record], {} as IntersectionObserver))
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    await view.navigate("/c/channels/s1/c1")
    expect(view.visible("m31")).toBe(true)
    expect(view.visible("m42")).toBe(false)
    const offset = view.root().scrollTop
    await view.canonical(42)
    expect(latest.feed.readSnapshot?.lastReadSeq).toBe(30)
    expect(view.root().scrollTop).toBe(offset)
    expect(messageOrReadRequests()).toEqual([])
  })

  it.each(["threshold", "inert", "document-hidden", "own-author"] as const)("does not turn a rejected %s observation into a newer return position", async control => {
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
    expect(view.visible("m31")).toBe(true)
    expect(messageOrReadRequests()).toEqual([])
  })
})
