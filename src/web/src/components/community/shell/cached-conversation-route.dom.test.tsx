import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLayoutEffect } from "react"
import { IsRestoringProvider, QueryClientProvider } from "@tanstack/react-query"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { CommunityRouteContext } from "./community-route-context"
import { CommunityModuleRoute } from "./community-module-route"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { conversationEntryFixture, seedConversationEntry } from "@/test/conversation-entry-fixtures"
import { act, render } from "@/test/react-dom-harness"
import { installMessageScrollFixture, restoreMessageScrollFixture, resize } from "@/test/message-scroll-fixture"
import { disposeReadCoordinator, getLocalReadingPosition } from "@/hooks/community/read-coordinator"
import { disposeAccountReadStateReconciliation } from "@/hooks/community/community-ws/read-state-reconciliation"

const mocks = vi.hoisted(() => ({ load: vi.fn(), replace: vi.fn(), memory: vi.fn(), dismiss: vi.fn(), snapshots: [] as unknown[], observedRows: new Set<Element>(), href: "/c/channels/old/old" }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
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
  useToggleMark: () => vi.fn(), useEditMessage: () => ({mutate: vi.fn()}),
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
  it("keeps a cold forum opener unknown through restore instead of mounting then removing the composer", async () => {
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
    expect(mounted.queryByTestId("qualified-composer")).toBeNull()
    mounted.rerender(node(false, false, target))
    await act(async () => {})
    expect(mounted.queryByTestId("qualified-composer")).toBeNull()
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
