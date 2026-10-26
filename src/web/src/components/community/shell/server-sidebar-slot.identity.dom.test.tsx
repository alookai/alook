import { IsRestoringProvider } from "@tanstack/react-query"
import { useLayoutEffect } from "react"
import { beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, setupUser, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref, type CommunityCommittedFrame } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { tid } from "@/lib/community/testids"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot, publishAccountAttentionSnapshot, clearAttentionScopeOptimistically, restoreAttentionScopeOptimisticSnapshot } from "@/lib/community-db/sync"
import { createOwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import { serversProjectedQueryFn } from "@/hooks/community/use-servers"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { ServerSidebarSlot } from "./server-sidebar-slot"
import { useCommunityNavigationController } from "./use-community-navigation-controller"

const mocks = vi.hoisted(() => ({ pathname: "/c/channels/target", push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), load: vi.fn() }))
vi.mock("next/link", async () => ({ default: (await import("@/test/community-link-mock")).CommunityLinkMock }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace, prefetch: mocks.prefetch }), usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams() }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: mocks.load }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "mobile", useIsMobile: () => true }))
vi.mock("@/hooks/community/use-server-members", () => ({ useServerMembers: () => ({ members: [] }) }))
vi.mock("@/hooks/community/use-server-panels", async original => ({ ...await original<typeof import("@/hooks/community/use-server-panels")>(), usePresence: () => {} }))
vi.mock("@/components/community/settings/server-settings", () => ({ ServerSettings: () => null }))
beforeEach(() => { vi.clearAllMocks(); mocks.pathname = "/c/channels/target"; mocks.load.mockImplementation(() => new Promise(() => {})) })

it.each([false, true])("keeps real same-server list, row and category nodes through native pending/commit and return, grouped=%s", async grouped => {
  const { client, registry } = await createCommunityQueryOwner()
  const server = { id: "target", name: "Target server", discriminator: "0001", description: "", icon: null, ownerId: "viewer" }
  const proof = { kind: "structural" as const, token: captureCommunityLiveSnapshotToken(client), signal: undefined }
  mocks.load.mockResolvedValueOnce({ servers: [{ ...server, role: "owner", memberId: "membership" }] })
  await client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(client) })
  mocks.load.mockClear()
  publishCommunityLiveSnapshot(client, { snapshot: { kind: "server-detail", data: { ...server, categories: [{ id: "category", name: grouped ? "Group" : "", private: 0, channels: [{ id: "channel", name: "Target channel", active: false, unread: true, muted: false, type: "text" }] }] } }, proof })
  client.setQueryData(communityKeys.server(server.id), server.id)
  client.setQueryData(communityKeys.forumSidebarThreads(server.id), { threads: [], verifiedEpoch: 0, serverNow: new Date().toISOString(), serverClockOffsetMs: 0 })
  const token = createOwnerServerDeleteRouteToken(client)
  function Harness({ frame }: { frame: CommunityCommittedFrame }) {
    const navigation = useCommunityNavigationController(frame)
    const runtime = useCommunityRuntime()
    useLayoutEffect(() => {
      runtime.ui.actions.registerUiHandlers({ navigatePath: navigation.push, cancelPendingNavigation: navigation.cancelPendingNavigation })
    }, [navigation.push, navigation.cancelPendingNavigation, runtime.ui])
    return <CommunityRouteContext value={{ breakpoint: "mobile", frame, navigation, ownerDeleteRouteScope: { serverId: server.id, token } }}>
      <output data-testid="pending">{String(navigation.navigationPending)}</output>
      <button onClick={() => navigation.replace("/c/channels/target", { resume: true })}>Return</button>
      <button onClick={() => navigation.cancelPendingNavigation()}>Cancel navigation</button>
      <ServerSidebarSlot serverId={server.id} href={navigation.pendingHref ?? frame.href} routeCommitted={!navigation.navigationPending} />
    </CommunityRouteContext>
  }
  const node = (href: string, revision: number) => <CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
      <IsRestoringProvider value><Harness frame={{ ...normalizeCommunityHref(href), revision }} /></IsRestoringProvider>
    </CurrentUserProvider>
  </CommunityTestProvider>
  const view = render(node("/c/channels/target", 0))
  const scroll = await view.findByTestId(tid.channelSidebarScroll)
  const row = view.getByTestId(tid.channelRow("channel"))
  const indicator = () => row.querySelector('[data-slot="community-channel-unread-indicator"]')
  expect(indicator()).toHaveClass("h-0")
  const attention = (seq: number) => publishAccountAttentionSnapshot(client, {
    snapshot: { scopes: [{ scopeId: "channel", channelId: "channel", serverId: server.id, parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: seq, attentionCount: 0, lastAttentionSeq: null }], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } },
    proof: { token: captureCommunityLiveSnapshotToken(client), signal: undefined },
  })
  await act(async () => { attention(4) })
  await waitFor(() => expect(indicator()).toHaveClass("h-2.5"))
  let optimistic!: ReturnType<typeof clearAttentionScopeOptimistically>
  await act(async () => { optimistic = clearAttentionScopeOptimistically(registry, "channel", 4) })
  await waitFor(() => expect(indicator()).toHaveClass("h-0"))
  expect(registry.collections.channels.get("channel")).not.toHaveProperty("unread")
  await act(async () => { attention(4) })
  expect(indicator()).toHaveClass("h-0")
  await act(async () => { attention(5) })
  await waitFor(() => expect(indicator()).toHaveClass("h-2.5"))
  await act(async () => {
    restoreAttentionScopeOptimisticSnapshot(registry, optimistic)
    publishAccountAttentionSnapshot(client, { snapshot: { scopes: [], items: [], limit: 100, truncated: false, included: { servers: [], channels: [], dms: [], profiles: [], messages: [] } }, proof: { token: captureCommunityLiveSnapshotToken(client), signal: undefined } })
  })
  await waitFor(() => expect(indicator()).toHaveClass("h-0"))
  const title = view.getByRole("button", { name: "Target server" })
  const invite = view.getByRole("button", { name: "Invite to server" })
  expect(row).toHaveAttribute("aria-roledescription", "draggable")
  const header = grouped ? view.getByText("Group") : null
  scroll.scrollTop = 37
  row.setAttribute("data-retained-row", "original")
  const assertNodes = () => {
    expect.soft(view.getByTestId(tid.channelSidebarScroll)).toBe(scroll)
    expect.soft(view.getByTestId(tid.channelSidebarScroll).scrollTop).toBe(37)
    expect.soft(view.getByTestId(tid.channelRow("channel"))).toBe(row)
    expect.soft(view.getByTestId(tid.channelRow("channel"))).toHaveAttribute("data-retained-row", "original")
    expect.soft(view.getByRole("button", { name: "Target server" })).toBe(title)
    expect.soft(view.getByRole("button", { name: "Invite to server" })).toBe(invite)
    if (header) expect.soft(view.getByText("Group")).toBe(header)
  }
  fireEvent.click(row)
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/channels/target/channel")
  expect(view.getByTestId("pending")).toHaveTextContent("true")
  assertNodes()
  expect(title).toBeDisabled()
  expect(invite).toBeDisabled()
  fireEvent.click(title)
  fireEvent.click(invite)
  expect(view.queryByRole("dialog")).toBeNull()
  expect(row).not.toHaveAttribute("aria-roledescription")
  fireEvent.contextMenu(view.getByTestId(tid.channelSidebarScroll), { button: 2 })
  expect(view.queryByRole("menu")).toBeNull()
  mocks.pathname = "/c/channels/target/channel"
  view.rerender(node(mocks.pathname, 1))
  await waitFor(() => expect(view.getByTestId("pending")).toHaveTextContent("false"))
  assertNodes()
  expect(title).toBeEnabled()
  expect(invite).toBeEnabled()
  fireEvent.click(view.getByRole("button", { name: "Return" }))
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/c/channels/target")
  expect(view.getByTestId("pending")).toHaveTextContent("true")
  assertNodes()
  mocks.pathname = "/c/channels/target"
  await act(async () => { view.rerender(node(mocks.pathname, 2)) })
  await waitFor(() => expect(view.getByTestId("pending")).toHaveTextContent("false"))
  assertNodes()
  expect(row).toHaveAttribute("aria-roledescription", "draggable")
  fireEvent.click(row)
  expect(view.getByTestId("pending")).toHaveTextContent("true")
  expect(title).toBeDisabled()
  expect(invite).toBeDisabled()
  fireEvent.click(view.getByRole("button", { name: "Cancel navigation" }))
  expect(view.getByTestId("pending")).toHaveTextContent("false")
  assertNodes()
  expect(title).toBeEnabled()
  expect(invite).toBeEnabled()
  const user = setupUser()
  act(() => row.focus())
  await user.keyboard(" ")
  expect(row).not.toHaveAttribute("aria-pressed")
  await user.keyboard("{Escape}")
  assertNodes()
  if (header) {
    fireEvent.click(header)
    expect(view.queryByTestId(tid.channelRow("channel"))).toBeNull()
    fireEvent.click(header)
    expect(view.getByTestId(tid.channelRow("channel"))).toBeVisible()
    expect(view.getByText("Group")).toBe(header)
    expect(view.getByTestId(tid.channelSidebarScroll)).toBe(scroll)
  }
  fireEvent.contextMenu(scroll, { button: 2 })
  expect(await view.findByRole("menuitem", { name: "Create category" })).toBeVisible()
  await user.keyboard("{Escape}")
  expect(mocks.load.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/channel/messages?entry=1"])
  expect(mocks.load.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true)
})
