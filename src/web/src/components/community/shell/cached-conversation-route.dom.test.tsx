import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StrictMode, useLayoutEffect } from "react"
import { IsRestoringProvider, QueryClientProvider } from "@tanstack/react-query"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { CommunityRouteContext } from "./community-route-context"
import { CommunityModuleRoute } from "./community-module-route"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize, scrollFixture } from "@/test/message-scroll-fixture"
import { useCommunityNavigationController } from "./use-community-navigation-controller"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { resolveCommunityLandingHref } from "@/lib/community/last-channel"
import { virtualListPositionKey } from "@/lib/community/virtual-list-position"
import { captureChannelMetadataToken } from "@/lib/community/conversation-qualification"
import { disposeReadCoordinator, getLocalReadingPosition } from "@/hooks/community/read-coordinator"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"

const mocks = vi.hoisted(() => ({ load: vi.fn(), push: vi.fn(), replace: vi.fn(), memory: vi.fn(), dismiss: vi.fn(), snapshots: [] as unknown[], observedRows: new Set<Element>(), href: "/c/channels/old/old" }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
  usePathname: () => mocks.href.split("?")[0],
  useSearchParams: () => new URLSearchParams(mocks.href.split("?")[1]),
}))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: (...args: unknown[]) => mocks.load(...args) }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop", useIsMobile: () => false }))
vi.mock("@/hooks/community/use-servers", () => ({ useServer: () => ({ server: null }) }))
vi.mock("@/components/community/members/channel-member-view-model", () => ({ useChannelMemberViewModel: () => ({ composerMembers: [], composerMentionCandidates: [], memberPanelProps: {}, manageMembersDialog: null, resolveUserName: (id: string) => id, myRole: "member" }) }))
vi.mock("@/hooks/community/use-notification-settings", () => ({ useNotificationSettings: () => ({ channel: {} }) }))
vi.mock("@/hooks/community/use-native-system-notifications", () => ({ useNativeSystemNotificationConversationDismissal: (...args: unknown[]) => mocks.dismiss(...args) }))
vi.mock("@/lib/community/last-community-route", async original => ({ ...await original<typeof import("@/lib/community/last-community-route")>(), commitCommunityChannelRoute: (...args: unknown[]) => mocks.memory(...args) }))
vi.mock("@/hooks/community/use-channel-message-feed", async original => {
  const actual = await original<typeof import("@/hooks/community/use-channel-message-feed")>()
  return {...actual, useChannelMessageFeed: (options: Parameters<typeof actual.useChannelMessageFeed>[0]) => {
    const result = actual.useChannelMessageFeed(options)
    useLayoutEffect(() => { mocks.snapshots.push(result.readSnapshot) }, [result.readSnapshot])
    return result
  }}
})
vi.mock("@/hooks/community/use-channel-panels", () => ({ usePins: () => ({pins: [], isLoading: false}), useThreads: () => ({threads: [], isLoading: false}) }))
vi.mock("@/hooks/community/mutations", () => ({
  useSendMessage: () => ({mutateAsync: vi.fn()}), useSetChannelNotif: () => ({mutate: vi.fn()}),
  useToggleReactionApi: () => vi.fn(), useAddReactionApi: () => vi.fn(),
  usePinMessage: () => ({mutate: vi.fn()}), useUnpinMessage: () => ({mutate: vi.fn()}),
  useToggleMark: () => vi.fn(),
  useCreateThread: () => ({mutateAsync: vi.fn()}), useUploadFile: () => ({mutateAsync: vi.fn()}),
}))
vi.mock("@/components/community/messages/composer", () => ({ Composer: () => <div data-testid="qualified-composer" />, ComposerSkeleton: () => null }))
vi.mock("@/components/community/messages/message-context-sheet", () => ({ MessageContextSheet: () => null }))
vi.mock("@/components/community/channels/channel-header", () => ({ ChannelHeader: ({channel}: {channel: string}) => <header>{channel}</header>, ChannelHeaderSkeleton: () => null }))

let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
let view: ReturnType<typeof render> | undefined
beforeEach(async () => {
  installMessageScrollFixture()
  vi.stubGlobal("matchMedia", vi.fn(() => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})))
  vi.stubGlobal("IntersectionObserver", class { observe(node: Element) { if (node.matches("[data-msg-id]")) mocks.observedRows.add(node) } unobserve() {} disconnect() {} takeRecords() { return [] } })
  owner = await createCommunityQueryOwner()
  view = undefined
  mocks.load.mockReset()
  mocks.observedRows.clear()
  mocks.snapshots.length = 0
  mocks.memory.mockClear()
  mocks.dismiss.mockClear()
  mocks.replace.mockClear()
  mocks.push.mockClear()
  mocks.href = "/c/channels/old/old"
  mocks.load.mockImplementation((url: string) => {
    if (url === "/api/community/users/me/attention") return Promise.resolve({scopes: [], items: [], limit: 100, truncated: false})
    throw new Error(`Unexpected cached-route request: ${url}`)
  })
})
afterEach(() => {
  view?.unmount()
  disposeReadCoordinator(owner.client)
  disposeAccountReadStateReconciliation(owner.client)
  restoreMessageScrollFixture()
})

const href = "/c/channels/s1/c1"
const entryIntent = {href}
function node(routeCommitted: boolean, restoring = false, target = href) {
  return <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>
    <CurrentUserProvider initialUser={{id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test"}}>
      <CommunityRouteContext value={{breakpoint: "desktop", frame: {revision: 1}, navigation: {entryIntent, pendingHref: routeCommitted ? null : href, publishedHref: mocks.href}} as never}>
        <IsRestoringProvider value={restoring}><CommunityModuleRoute href={target} routeCommitted={routeCommitted} /></IsRestoringProvider>
      </CommunityRouteContext>
    </CurrentUserProvider>
  </CommunityDbProvider></QueryClientProvider>
}
async function mount(restoring = false, target = href) {
  await act(async () => {
    view = render(node(false, restoring, target))
    await import("../channels/server-conversation-route")
  })
  resize()
  await act(async () => {})
  return view!
}

describe("cached target through the real route, entry and message consumers", () => {
  it.each([false, true])("keeps the restored offset through an already-active row selection after a server return (StrictMode=%s)", async strict => {
    const entry = conversationEntryFixture()
    entry.channel = { ...entry.channel, type: "text", messageCount: 42 }
    entry.messages = Array.from({ length: 42 }, (_, index) => ({ ...entry.messages[0], id: `m${index + 1}`, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index + 1)).toISOString() }))
    entry.readState = { channelId: "c1", lastReadMessageId: "m42", lastReadSeq: 42, lastReadAt: entry.messages[41].createdAt }
    entry.selection = { reason: "tail", anchorMessageId: null }
    entry.page = { ...entry.page, hasMoreOlder: false, hasMoreNewer: false, olderCursor: null, newerCursor: null, latestSeq: 42 }
    await seedConversationEntry(owner.client, entry)
    scrollFixture.width = 905
    scrollFixture.height = 683
    entry.messages.forEach((message, index) => scrollFixture.bodyHeights.set(message.id, 90 + index % 5 * 31))
    mocks.href = href
    let revision = 1
    let navigation!: ReturnType<typeof useCommunityNavigationController>
    function Route() {
      const current = useCommunityNavigationController({ ...normalizeCommunityHref(mocks.href), revision })
      const target = current.pendingHref ?? mocks.href
      useLayoutEffect(() => { navigation = current }, [current])
      return <CommunityRouteContext value={{ breakpoint: "desktop", frame: { revision }, navigation: current } as never}>
        {target.startsWith("/c/channels/")
          ? <CommunityModuleRoute key="server:s1" href={target} routeCommitted={!current.navigationPending} />
          : <div data-testid="away">Away</div>}
      </CommunityRouteContext>
    }
    const tree = () => <QueryClientProvider client={owner.client}><CommunityDbProvider registry={owner.registry}>
      <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
        {strict ? <StrictMode><Route /></StrictMode> : <Route />}
      </CurrentUserProvider>
    </CommunityDbProvider></QueryClientProvider>
    view = render(tree())
    resize()
    const root = () => view!.getByTestId("community-message-scroller")
    const previous = root()
    fireEvent.wheel(previous, { deltaY: -600 })
    act(() => previous.scrollTo({ top: previous.scrollHeight - previous.clientHeight - 600 }))
    resize()
    const body = Array.from(previous.querySelectorAll<HTMLElement>("[data-msg-id]"))
      .find(row => row.getBoundingClientRect().bottom > 0)!
    const id = body.dataset.msgId!
    const top = body.getBoundingClientRect().top
    const offset = previous.scrollTop
    const scope = { proof: captureChannelMetadataToken(owner.client, "c1"), kind: "messages" as const, tag: null }
    expect(owner.client.getQueryData(virtualListPositionKey(scope))).toMatchObject({ offset })
    const go = async (target: string) => {
      await act(async () => navigation.push(target))
      mocks.href = target
      revision += 1
      await act(async () => view!.rerender(tree()))
      resize()
    }
    await go("/c/me/friends")
    await go("/c/me/dm-test")
    expect(previous.isConnected).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    const previousLoad = mocks.load.getMockImplementation()!
    mocks.load.mockImplementation((url: string) => url === "/api/community/channels/c1/messages?entry=1"
      ? new Promise(() => {}) : previousLoad(url))
    const serverTarget = resolveCommunityLandingHref({ serverId: "s1", channelIds: ["c1"], last: "c1", breakpoint: "desktop" })
    await go(serverTarget)
    expect(serverTarget).toBe(href)
    expect(mocks.load.mock.calls.some(([url]) => url === "/api/community/channels/c1/messages?entry=1")).toBe(true)
    expect(root().scrollTop).toBeCloseTo(offset, 0)
    expect(root().querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!.getBoundingClientRect().top).toBeCloseTo(top, 0)
    const admitted = navigation.entryIntent
    await act(async () => { navigation.cancelPendingNavigation(); navigation.push(href) })
    resize()
    expect(root().scrollTop).toBeCloseTo(offset, 0)
    expect(root().querySelector<HTMLElement>(`[data-msg-id="${id}"]`)!.getBoundingClientRect().top).toBeCloseTo(top, 0)
    expect(navigation.entryIntent).toBe(admitted)
    expect(mocks.load.mock.calls.filter(([url, options]) => String(url).endsWith("/read") && options?.method === "PUT")).toEqual([])
  })

  it("mounts cached forum child messages and keeps its composer while the opener remains pending", async () => {
    const entry = conversationEntryFixture()
    entry.channel = { ...entry.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    entry.surfaceReceipt = { channelId: entry.channelId, surfaceKind: "thread" }
    entry.parent = { ...conversationEntryFixture().channel, id: "parent", type: "forum", name: "Forum" }
    entry.selection = { reason: "tail", anchorMessageId: null }
    entry.page = { ...entry.page, olderCursor: null, hasMoreOlder: false }
    await seedConversationEntry(owner.client, entry)
    mocks.load.mockImplementation((url: string) => {
      if (url === "/api/community/messages/opener") return new Promise(() => {})
      if (url === "/api/community/users/me/attention") return Promise.resolve({ scopes: [], items: [], limit: 100, truncated: false })
      throw new Error(`Unexpected cold-opener request: ${url}`)
    })
    const target = `${href}?threadView=full`
    const mounted = await mount(true, target)
    const composer = mounted.getByTestId("qualified-composer")
    const scroller = mounted.getByTestId("community-message-scroller")
    expect(composer).toBeVisible()
    mounted.rerender(node(false, false, target))
    await act(async () => {})
    expect(mounted.getByTestId("qualified-composer")).toBe(composer)
    expect(mounted.getByTestId("community-message-scroller")).toBe(scroller)
  })

  it("keeps a canonical cached forum opener and composer through restore and route commit", async () => {
    const entry = conversationEntryFixture()
    entry.channel = { ...entry.channel, type: "thread", parentChannelId: "parent", parentMessageId: "opener" }
    entry.surfaceReceipt = { channelId: entry.channelId, surfaceKind: "thread" }
    entry.parent = { ...conversationEntryFixture().channel, id: "parent", type: "forum", name: "Forum" }
    entry.opener = { ...entry.messages[0], id: "opener", channelId: "parent", content: "Cached post title" }
    entry.selection = { reason: "tail", anchorMessageId: null }
    entry.page = { ...entry.page, olderCursor: null, hasMoreOlder: false }
    await seedConversationEntry(owner.client, entry)
    mocks.load.mockImplementation((url: string) => {
      if (url === "/api/community/messages/opener") return Promise.resolve(entry.opener)
      if (url === "/api/community/users/me/attention") return Promise.resolve({ scopes: [], items: [], limit: 100, truncated: false })
      throw new Error(`Unexpected cached-opener request: ${url}`)
    })
    const target = `${href}?threadView=full`
    const mounted = await mount(true, target)
    const composer = mounted.getByTestId("qualified-composer")
    expect(composer).toBeVisible()
    mounted.rerender(node(false, false, target))
    await act(async () => {})
    expect(mounted.getByTestId("qualified-composer")).toBe(composer)
    mocks.href = target
    mounted.rerender(node(true, false, target))
    expect(mounted.getByTestId("qualified-composer")).toBe(composer)
  })

  it("shows qualified messages before publication and keeps the same scroller through commit", async () => {
    const entry = conversationEntryFixture()
    entry.messages[0].content = "Cached target body"
    entry.readState = {...entry.readState, lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0}
    entry.selection = {reason: "tail", anchorMessageId: null}
    entry.page = {...entry.page, olderCursor: null, hasMoreOlder: false}
    await seedConversationEntry(owner.client, entry)
    const mounted = await mount()
    const root = mounted.getByTestId("community-message-scroller")
    expect(mounted.getByText("Cached target body")).toBeVisible()
    const row = root.querySelector('[data-msg-id="m1"]')
    expect(row).not.toBeNull()
    const content = root.querySelector('[data-message-list-content]')!
    expect(content).toHaveAttribute("data-initial-position-phase", "revealed")
    expect(content).toHaveAttribute("data-read-position-ready", "false")
    const beforeCommitOffset = root.scrollTop
    const snapshot = mocks.snapshots.at(-1)
    expect(snapshot).toMatchObject({lastReadSeq: 0})
    expect(mocks.observedRows.size).toBe(0)
    expect(mocks.href).toBe("/c/channels/old/old")
    expect(owner.runtime.ui.get().currentChannelId).toBeNull()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.dismiss.mock.calls.every(([, , ready]) => ready === false)).toBe(true)
    expect(getLocalReadingPosition(owner.client, "c1")).toBeNull()
    expect(mocks.load.mock.calls.filter(([url]) => String(url).endsWith("/read"))).toEqual([])
    mocks.href = href
    mounted.rerender(node(true))
    resize()
    await act(async () => {})
    expect(mounted.getByTestId("community-message-scroller")).toBe(root)
    expect(root.querySelector('[data-msg-id="m1"]')).toBe(row)
    expect(root.scrollTop).toBe(beforeCommitOffset)
    expect(content).toHaveAttribute("data-read-position-ready", "true")
    expect(owner.runtime.ui.get().currentChannelId).toBe("c1")
    expect(mocks.snapshots.at(-1)).toBe(snapshot)
    expect(mocks.observedRows.has(row!)).toBe(true)
    expect(mocks.memory).toHaveBeenCalledWith("viewer", "s1", "c1")
    expect(mocks.dismiss).toHaveBeenLastCalledWith("viewer", {kind: "server", serverId: "s1", channelId: "c1"}, true)
  })

  it("does not admit cached messages after the target channel is revoked", async () => {
    await seedConversationEntry(owner.client, conversationEntryFixture())
    act(() => owner.runtime.ws.actions.revokeChannelAccess("s1", "c1"))
    const mounted = await mount()
    expect(mounted.queryByText("Body")).toBeNull()
    expect(mounted.container.querySelector("[data-msg-id]")).toBeNull()
    expect(mocks.memory).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
