import { IsRestoringProvider } from "@tanstack/react-query"
import { beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent, render, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { createOwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import { serversProjectedQueryFn } from "@/hooks/community/use-servers"
import { ServerSidebarSlot } from "./server-sidebar-slot"

const mocks = vi.hoisted(() => ({ pathname: "/c/channels/source/channel", search: "settings=1", breakpoint: "desktop", replace: vi.fn(), members: vi.fn(), presence: vi.fn(), props: vi.fn(), load: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: mocks.load }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint, useIsMobile: () => mocks.breakpoint === "mobile" }))
vi.mock("@/hooks/community/use-server-members", () => ({ useServerMembers: (id: string | null) => { mocks.members(id); return { members: [] } } }))
vi.mock("@/hooks/community/use-server-panels", () => ({ usePresence: mocks.presence }))
vi.mock("@/components/community/channels/channel-sidebar-tree-owner", () => ({ ChannelSidebarRevealBoundary: (props: { serverName: string; categories: Array<{ channels: Array<{ id: string; name: string }> }> }) => {
  mocks.props(props)
  return <aside><h1>{props.serverName}</h1><input aria-label="Sidebar state" />{props.categories.flatMap(category => category.channels).map(channel => <span key={channel.id}>{channel.name}</span>)}</aside>
} }))
vi.mock("@/components/community/settings/server-settings", () => ({ ServerSettings: () => <div>Server settings</div> }))
beforeEach(() => { vi.clearAllMocks(); mocks.pathname = "/c/channels/source/channel"; mocks.search = "settings=1"; mocks.breakpoint = "desktop"; mocks.load.mockImplementation(() => new Promise(() => {})) })

it("uses the canonical target sidebar before commit, retaining its node while deferred side effects gain the real route", async () => {
  const { client, registry } = await createCommunityQueryOwner()
  const server = { id: "target", name: "Target server", discriminator: "0001", description: "", icon: null, ownerId: "viewer" }
  const proof = { kind: "structural" as const, token: captureCommunityLiveSnapshotToken(client), signal: undefined }
  publishCommunityLiveSnapshot(client, { snapshot: { kind: "servers", data: { servers: [{ ...server, initial: "T", active: false, unread: false, mentions: 0, isOwner: true, role: "owner", memberId: "membership" }] } }, proof })
  publishCommunityLiveSnapshot(client, { snapshot: { kind: "server-detail", data: { ...server, categories: [{ id: "category", name: "Main", private: 0, channels: [{ id: "channel", name: "Target channel", active: false, unread: false, muted: false, type: "text" }] }] } }, proof })
  client.setQueryData(communityKeys.servers(), [server.id])
  client.setQueryData(communityKeys.server(server.id), server.id)
  const sourceToken = createOwnerServerDeleteRouteToken(client)
  const targetToken = createOwnerServerDeleteRouteToken(client)
  const node = (committed: boolean) => <CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
      <IsRestoringProvider value>
        <CommunityRouteContext value={{ frame: { ...normalizeCommunityHref(mocks.pathname), revision: committed ? 2 : 1 }, navigation: { captureIntent: () => () => true, navigationPending: !committed, pendingHref: committed ? null : "/c/channels/target?settings=1" }, ownerDeleteRouteScope: { serverId: committed ? "target" : "source", token: committed ? targetToken : sourceToken } } as never}>
          <ServerSidebarSlot serverId="target" href="/c/channels/target?settings=1" routeCommitted={committed} />
        </CommunityRouteContext>
      </IsRestoringProvider>
    </CurrentUserProvider>
  </CommunityTestProvider>
  const view = render(node(false))
  expect(view.getByText("Target server")).toBeVisible()
  expect(view.getByText("Target channel")).toBeVisible()
  const input = view.getByRole("textbox") as HTMLInputElement
  input.value = "Target state"
  expect(mocks.members).toHaveBeenLastCalledWith(null)
  expect(mocks.presence).toHaveBeenLastCalledWith(null)
  expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ onCreateChannel: undefined, onOpenSettings: undefined }))
  expect(view.queryByText("Server settings")).toBeNull()
  expect(mocks.replace).not.toHaveBeenCalled()
  expect(mocks.load).not.toHaveBeenCalled()
  mocks.pathname = "/c/channels/target"
  view.rerender(node(true))
  expect(view.getByRole("textbox")).toBe(input)
  expect(input).toHaveValue("Target state")
  expect(mocks.members).toHaveBeenLastCalledWith("target")
  expect(mocks.presence).toHaveBeenLastCalledWith("target")
})

it.each(["primary", "forum"])("ends a failed cold %s read with retry", async kind => {
  const { client, registry } = await createCommunityQueryOwner()
  const server = { id: "target", name: "Target server", discriminator: "0001", description: "", icon: null, ownerId: "viewer" }
  publishCommunityLiveSnapshot(client, {
    snapshot: { kind: "servers", data: { servers: [{ ...server, initial: "T", active: false, unread: false, mentions: 0 }] } },
    proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined },
  })
  client.setQueryData(communityKeys.servers(), [server.id])
  let fail = true
  mocks.load.mockImplementation((url: string) => {
    if (url === "/api/community/servers/target/categories") {
      return kind === "primary" && fail ? Promise.reject(new Error("Temporary read failure")) : Promise.resolve({ categories: [] })
    }
    if (url === "/api/community/servers/target/channels") return Promise.resolve({ channels: kind === "forum" ? [{ id: "forum", name: "Forum", type: "forum", categoryId: null, position: 0 }] : [] })
    if (url.startsWith("/api/community/servers/target/channels?")) {
      return kind === "forum" && fail ? Promise.reject(new Error("Forum unavailable")) : Promise.resolve({ channels: [], included: { parentMessages: [] }, serverNow: new Date().toISOString() })
    }
    return new Promise(() => {})
  })
  mocks.pathname = "/c/channels/target"
  const token = createOwnerServerDeleteRouteToken(client)
  const view = render(<CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
      <CommunityRouteContext value={{ frame: { ...normalizeCommunityHref(mocks.pathname), revision: 0 }, navigation: { captureIntent: () => () => true, navigationPending: false, pendingHref: null }, ownerDeleteRouteScope: { serverId: "target", token } } as never}>
        <ServerSidebarSlot serverId="target" />
      </CommunityRouteContext>
    </CurrentUserProvider>
  </CommunityTestProvider>)
  expect(await view.findByRole("alert")).toHaveTextContent(kind === "primary" ? "Couldn't load server channels." : "Couldn't load forum posts.")
  expect(view.queryByText("Target server")).toBeNull()
  expect(view.getByRole("button", { name: "Retry" })).toBeEnabled()
  fail = false
  fireEvent.click(view.getByRole("button", { name: "Retry" }))
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull())
  expect(view.getByText("Target server")).toBeVisible()
  expect(mocks.load.mock.calls.filter(([path]) => path === "/api/community/servers/target/categories")).toHaveLength(kind === "primary" ? 2 : 1)
  expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ categories: kind === "primary" ? [] : expect.arrayContaining([expect.objectContaining({ channels: [expect.objectContaining({ id: "forum" })] })]), primaryReady: true, forumProjectionMissing: false }))
})


it.each([
  { marker: "settings", role: "owner", order: "detail-first" }, { marker: "invite", role: "owner", order: "detail-first" },
  { marker: "settings", role: "member", order: "detail-first" },
  { marker: "settings", role: "owner", order: "owner-first" }, { marker: "invite", role: "owner", order: "owner-first" },
])("preserves a mobile first $marker intent through $role qualification with $order", async ({ marker, role, order }) => {
  const { client, registry } = await createCommunityQueryOwner()
  const server = { id: "target", name: "Target server", discriminator: "0001", description: "", icon: null, ownerId: "viewer" }
  mocks.pathname = "/c/channels/target"
  mocks.search = `${marker}=1&keep=${marker}`
  mocks.breakpoint = "mobile"
  const token = createOwnerServerDeleteRouteToken(client)
  const node = (committed = true) => <CommunityTestProvider client={client} registry={registry}>
    <CurrentUserProvider initialUser={{ id: "viewer", name: "Viewer", avatar: "V", email: "viewer@example.test" }}>
      <IsRestoringProvider value>
        <CommunityRouteContext value={{ frame: { ...normalizeCommunityHref(mocks.pathname), revision: 1 }, navigation: { captureIntent: () => () => true, navigationPending: !committed, pendingHref: null }, ownerDeleteRouteScope: { serverId: "target", token } } as never}>
          <ServerSidebarSlot serverId="target" routeCommitted={committed} />
        </CommunityRouteContext>
      </IsRestoringProvider>
    </CurrentUserProvider>
  </CommunityTestProvider>
  const view = render(node())
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(`/c/channels/target?keep=${marker}`))
  mocks.search = `keep=${marker}`
  view.rerender(node())
  const qualify = async () => {
    mocks.load.mockResolvedValueOnce({ servers: [{ ...server, role, memberId: "membership" }] })
    await act(async () => { await client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(client), staleTime: 0 }) })
  }
  if (order === "owner-first") {
    await qualify()
    await waitFor(() => expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ onOpenSettings: expect.any(Function) })))
    expect(view.queryByText("Server settings")).toBeNull()
  }
  act(() => { publishCommunityLiveSnapshot(client, { snapshot: { kind: "server-detail", data: { ...server, categories: [] } }, proof: { kind: "structural", token: captureCommunityLiveSnapshotToken(client), signal: undefined } }) })
  await waitFor(() => expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ serverName: "Target server", onOpenSettings: undefined, onInvitePopoverOpenChange: undefined })))
  expect(view.queryByText("Server settings")).toBeNull()
  if (order === "detail-first") await qualify()
  act(() => { client.setQueryData(communityKeys.server(server.id), server.id) })
  view.rerender(node())
  if (role === "member") {
    expect(view.queryByText("Server settings")).toBeNull()
    mocks.load.mockResolvedValueOnce({ servers: [{ ...server, role: "owner", memberId: "membership" }] })
    await act(async () => { await client.query({ queryKey: communityKeys.servers(), queryFn: serversProjectedQueryFn(client), staleTime: 0 }) })
    await waitFor(() => expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ onOpenSettings: expect.any(Function) })))
    expect(view.queryByText("Server settings")).toBeNull()
    return
  }
  if (marker === "settings") expect(await view.findByText("Server settings")).toBeVisible()
  else await waitFor(() => expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ invitePopoverOpen: true, onInvitePopoverOpenChange: expect.any(Function) })))
  view.rerender(node(false))
  await waitFor(() => {
    if (marker === "settings") expect(view.queryByText("Server settings")).toBeNull()
    else expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ invitePopoverOpen: false }))
  })
  view.rerender(node())
  expect(view.queryByText("Server settings")).toBeNull()
  expect(mocks.props).toHaveBeenLastCalledWith(expect.objectContaining({ invitePopoverOpen: false }))
})
