import { createElement, type ReactNode } from "react"
import { renderToString } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityRouteFrame } from "./community-route-frame"
import { useCommunityRouteFrame } from "./community-route-context"
import ServerContent from "@/app/c/channels/layout"
import { CommunitySessionPendingFrame } from "./community-session-pending-frame"
import { tid } from "@/lib/community/testids"

const mocks = vi.hoisted(() => ({
  segments: ["me", "friends"],
  pathname: "/c/me/friends",
  search: "",
  mergedServerId: "wrong-sidebar-server",
  breakpoint: "desktop",
  userId: "viewer-a",
  push: vi.fn(),
  replace: vi.fn(),
  channel: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useSelectedLayoutSegments: () => mocks.segments,
  useParams: () => ({ serverId: mocks.mergedServerId }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: mocks.userId }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false, useBreakpoint: () => mocks.breakpoint }))
vi.mock("@/lib/community-onboarding", () => ({ useCommunityOnboarding: () => null }))
vi.mock("./use-shell-rail-controller", () => ({
  useShellRailController: () => ({ railProps: {}, navigate: vi.fn() }),
}))
vi.mock("./use-shell-profile-controller", () => ({
  useShellProfileController: () => ({
    currentUser: { id: mocks.userId, name: mocks.userId, avatar: "V" },
    profile: null, closeProfile: vi.fn(), openProfile: vi.fn(),
  }),
}))
vi.mock("./use-shell-inbox-controller", () => ({
  useShellInboxController: () => ({ open: false, popoverProps: {}, onOpenChange: vi.fn() }),
}))
vi.mock("./use-shell-daemon-update-controller", () => ({
  useShellDaemonUpdateController: () => ({ update: null, eligibleMachines: [], collapse: vi.fn() }),
}))
vi.mock("@/hooks/community/use-running-owned-bots", () => ({
  useRunningOwnedBots: () => ({ runningBots: [] }),
}))
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}))
vi.mock("@/components/ui/resizable", () => {
  const Panel = ({ children }: { children: ReactNode }) => createElement("div", null, children)
  return { ResizablePanelGroup: Panel, ResizablePanel: Panel, ResizableHandle: () => null }
})
vi.mock("./server-rail", () => ({ ServerRail: () => <div data-testid="rail"><button data-testid="home">Home</button><input data-testid="rail-state" /></div> }))
vi.mock("./user-bar", () => ({ UserBar: () => <div data-testid="userbar">{mocks.userId}</div> }))
vi.mock("@/components/community/social/friends-route", () => ({ default: () => <div data-testid="main">me/friends</div> }))
vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({ AlookLoading: () => null }))
vi.mock("./community-inbox-popover", () => ({ InboxPopover: () => null }))
vi.mock("./shell-frame-overlays", () => ({ ShellFrameOverlays: () => null }))
vi.mock("@/components/community/channels/dm-route", () => ({ DmRoute: ({ dmId, routeCommitted }: { dmId: string; routeCommitted: boolean }) => createElement("main", { "data-dm-target": dmId, "data-committed": String(routeCommitted) }) }))
vi.mock("@/components/community/channels/channel-route", () => ({
  ChannelRoute: (props: { serverParam: string; channelId: string }) => {
    mocks.channel(props)
    return <div data-testid="channel">{props.serverParam}/{props.channelId}</div>
  },
}))

function Sidebar({ serverId }: { serverId: string | null }) {
  const { frame, ownerDeleteRouteScope } = useCommunityRouteFrame()
  const valid = serverId ? frame.scope.kind === "server" && frame.scope.serverId === serverId
    && ownerDeleteRouteScope?.serverId === serverId : frame.scope.kind === "me"
  return valid ? <input data-testid="sidebar" data-server-id={serverId ?? "me"} /> : null
}

let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
beforeEach(async () => {
  owner = await createCommunityQueryOwner("viewer-a")
  mocks.userId = "viewer-a"
  mocks.segments = ["me", "friends"]
  mocks.pathname = "/c/me/friends"
  mocks.search = ""
  mocks.breakpoint = "desktop"
  mocks.channel.mockClear()
  mocks.push.mockClear()
  mocks.replace.mockClear()
})

function tree(serverId: string | null = null) {
  return <CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
    <CommunityRouteFrame sidebar={<Sidebar key={serverId ?? "me"} serverId={serverId} />}>
      <div data-testid="main">{mocks.segments.join("/")}</div>
    </CommunityRouteFrame>
  </CommunityTestProvider>
}

describe("common committed community frame", () => {
  it("keeps the unresolved root neutral inside the common route frame", () => {
    mocks.segments = []
    mocks.pathname = "/c"
    const html = renderToString(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <CommunityRouteFrame sidebar={null}><CommunitySessionPendingFrame pathname="/c" /></CommunityRouteFrame>
    </CommunityTestProvider>)
    expect(html.split(`data-testid="${tid.initialFrame}"`)).toHaveLength(2)
    expect(html).not.toContain('data-slot="community-shell-root"')
    expect(html).not.toContain('data-testid="rail"')
    expect(html).not.toContain('data-testid="userbar"')
  })

  it("retains global nodes and state across me/server and preserves same-server sidebar", async () => {
    const view = render(tree())
    await act(async () => {})
    const rail = view.getByTestId("rail")
    const home = view.getByTestId("home")
    const userbar = view.getByTestId("userbar")
    fireEvent.change(view.getByTestId("rail-state"), { target: { value: "retained" } })
    for (const [serverId, leaf] of [["a", "one"], ["a", "two"], ["b", "one"], [null, "friends"]] as const) {
      mocks.segments = serverId ? ["channels", serverId, leaf] : ["me", leaf]
      mocks.pathname = `/c/${mocks.segments.join("/")}`
      const previousSidebar = view.queryByTestId("sidebar")
      const previousServer = previousSidebar?.getAttribute("data-server-id")
      view.rerender(tree(serverId))
      expect(view.getByTestId("rail")).toBe(rail)
      expect(view.getByTestId("home")).toBe(home)
      expect(view.getByTestId("userbar")).toBe(userbar)
      expect(view.getByTestId("rail-state")).toHaveValue("retained")
      if (previousServer === serverId) expect(view.getByTestId("sidebar")).toBe(previousSidebar)
      expect(owner.registry.runtime.ui.get().currentServerId).toBe(serverId)
    }
    act(() => owner.registry.runtime.ws.setState((state) => ({ ...state, accessEpoch: state.accessEpoch + 1 })))
    expect(view.getByTestId("rail")).toBe(rail)
  })

  it("ignores ahead-of-commit pathname and gates mismatched sidebar scope", async () => {
    const view = render(tree())
    await act(async () => {})
    mocks.pathname = "/c/channels/b/two"
    view.rerender(tree("b"))
    expect(view.queryByTestId("sidebar")).toBeNull()
    expect(owner.registry.runtime.ui.get().currentServerId).toBeNull()
    expect(view.getByTestId("main")).toHaveTextContent("me/friends")
    mocks.segments = ["channels", "b", "two"]
    view.rerender(tree("b"))
    expect(view.getByTestId("sidebar")).toHaveAttribute("data-server-id", "b")
  })

  it.each(["url-first", "segments-first"])("gates DM query effects on exact publication in %s order", async order => {
    mocks.segments = ["me", "dm-a"]
    mocks.pathname = "/c/me/dm-a"
    const view = render(tree())
    await act(async () => {})
    expect(view.container.querySelector('[data-dm-target="dm-a"]')).toHaveAttribute("data-committed", "true")
    act(() => owner.runtime.ui.get().uiHandlers.navigatePath?.("/c/me/dm-b?seq=7"))
    const body = view.container.querySelector('[data-dm-target="dm-b"]')!
    expect(body).toHaveAttribute("data-committed", "false")
    if (order === "url-first") { mocks.pathname = "/c/me/dm-b"; mocks.search = "seq=7" }
    else mocks.segments = ["me", "dm-b"]
    view.rerender(tree())
    expect(view.container.querySelector('[data-dm-target="dm-b"]')).toBe(body)
    expect(body).toHaveAttribute("data-committed", "false")
    mocks.segments = ["me", "dm-b"]
    mocks.pathname = "/c/me/dm-b"
    mocks.search = "seq=7"
    view.rerender(tree())
    expect(view.container.querySelector('[data-dm-target="dm-b"]')).toBe(body)
    expect(body).toHaveAttribute("data-committed", "true")
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/c/me/dm-b?seq=7")
  })

  it("preserves hidden global mobile nodes and rebuilds them for a new account", async () => {
    mocks.breakpoint = "mobile"
    mocks.segments = ["me"]
    const view = render(tree())
    await act(async () => {})
    const home = view.getByTestId("home")
    const userbar = view.getByTestId("userbar")
    mocks.segments = ["me", "dm-a"]
    mocks.pathname = "/c/me/dm-a"
    view.rerender(tree())
    expect(view.getByTestId("home")).toBe(home)
    expect(view.getByTestId("rail").parentElement).toHaveAttribute("inert")
    expect(view.getByTestId("userbar")).toBe(userbar)
    expect(userbar.parentElement).toHaveAttribute("aria-hidden", "true")
    expect(userbar.parentElement).toHaveAttribute("inert")
    owner = await createCommunityQueryOwner("viewer-b")
    mocks.userId = "viewer-b"
    view.rerender(tree())
    expect(view.getByTestId("home")).not.toBe(home)
    expect(view.getByTestId("userbar")).not.toBe(userbar)
  })

  it("takes server content identity from its own segments despite merged slot params", () => {
    mocks.segments = ["a", "channel-a"]
    mocks.search = "msg=other-slot&threadView=full"
    const view = render(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <CommunityRouteFrame sidebar={null}><ServerContent><span>static child</span></ServerContent></CommunityRouteFrame>
    </CommunityTestProvider>)
    expect(mocks.channel).toHaveBeenLastCalledWith({
      serverParam: "a", channelId: "channel-a",
      targetHref: "/c/channels/a/channel-a", routeCommitted: false,
    })
    mocks.pathname = "/c/channels/a/channel-a"
    mocks.search = "msg=own-anchor&threadView=full"
    view.rerender(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <CommunityRouteFrame sidebar={null}><ServerContent><span>static child</span></ServerContent></CommunityRouteFrame>
    </CommunityTestProvider>)
    expect(mocks.channel).toHaveBeenLastCalledWith({
      serverParam: "a", channelId: "channel-a",
      targetHref: "/c/channels/a/channel-a?msg=own-anchor&threadView=full", routeCommitted: true,
    })
    mocks.segments = ["a", "settings"]
    view.rerender(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <CommunityRouteFrame sidebar={null}><ServerContent><span>static child</span></ServerContent></CommunityRouteFrame>
    </CommunityTestProvider>)
    expect(view.getByText("static child")).toBeInTheDocument()
    expect(view.queryByTestId("channel")).toBeNull()
  })
})
