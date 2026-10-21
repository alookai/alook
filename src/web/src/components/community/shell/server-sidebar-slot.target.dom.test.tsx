import { IsRestoringProvider } from "@tanstack/react-query"
import { beforeEach, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken, publishCommunityLiveSnapshot } from "@/lib/community-db/sync"
import { createOwnerServerDeleteRouteToken } from "@/lib/community/eject-server"
import { ServerSidebarSlot } from "./server-sidebar-slot"

const mocks = vi.hoisted(() => ({ pathname: "/c/channels/source/channel", replace: vi.fn(), members: vi.fn(), presence: vi.fn(), props: vi.fn(), load: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => mocks.pathname, useSearchParams: () => new URLSearchParams("settings=1") }))
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), apiFetch: mocks.load }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop", useIsMobile: () => false }))
vi.mock("@/hooks/community/use-server-members", () => ({ useServerMembers: (id: string | null) => { mocks.members(id); return { members: [] } } }))
vi.mock("@/hooks/community/use-server-panels", () => ({ usePresence: mocks.presence }))
vi.mock("@/components/community/channels/channel-sidebar-tree-owner", () => ({ ChannelSidebarRevealBoundary: (props: { serverName: string; categories: Array<{ channels: Array<{ id: string; name: string }> }> }) => {
  mocks.props(props)
  return <aside><h1>{props.serverName}</h1><input aria-label="Sidebar state" />{props.categories.flatMap(category => category.channels).map(channel => <span key={channel.id}>{channel.name}</span>)}</aside>
} }))
vi.mock("@/components/community/settings/server-settings", () => ({ ServerSettings: () => <div>Server settings</div> }))
beforeEach(() => { vi.clearAllMocks(); mocks.pathname = "/c/channels/source/channel"; mocks.load.mockImplementation(() => new Promise(() => {})) })

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
