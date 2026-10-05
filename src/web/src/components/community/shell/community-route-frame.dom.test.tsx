import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityRouteFrame } from "./community-route-frame"
import { useCommunityRouteFrame } from "./community-route-context"
import ServerContent from "@/app/c/channels/layout"

const mocks = vi.hoisted(() => ({
  segments: ["me", "friends"],
  pathname: "/c/me/friends",
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
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: mocks.userId }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => mocks.breakpoint }))
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
vi.mock("./community-inbox-popover", () => ({ InboxPopover: () => null }))
vi.mock("./shell-frame-overlays", () => ({ ShellFrameOverlays: () => null }))
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
  it("retains global nodes and state across me/server and preserves same-server sidebar", () => {
    const view = render(tree())
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

  it("ignores ahead-of-commit pathname and gates mismatched sidebar scope", () => {
    const view = render(tree())
    mocks.pathname = "/c/channels/b/two"
    view.rerender(tree("b"))
    expect(view.queryByTestId("sidebar")).toBeNull()
    expect(owner.registry.runtime.ui.get().currentServerId).toBeNull()
    expect(view.getByTestId("main")).toHaveTextContent("me/friends")
    mocks.segments = ["channels", "b", "two"]
    view.rerender(tree("b"))
    expect(view.getByTestId("sidebar")).toHaveAttribute("data-server-id", "b")
  })

  it("preserves hidden global mobile nodes and rebuilds them for a new account", async () => {
    mocks.breakpoint = "mobile"
    mocks.segments = ["me"]
    const view = render(tree())
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
    const view = render(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <CommunityRouteFrame sidebar={null}><ServerContent><span>static child</span></ServerContent></CommunityRouteFrame>
    </CommunityTestProvider>)
    expect(mocks.channel).toHaveBeenLastCalledWith({ serverParam: "a", channelId: "channel-a" })
    mocks.segments = ["a", "settings"]
    view.rerender(<CommunityTestProvider client={owner.client} registry={owner.registry} retainOwner>
      <CommunityRouteFrame sidebar={null}><ServerContent><span>static child</span></ServerContent></CommunityRouteFrame>
    </CommunityTestProvider>)
    expect(view.getByText("static child")).toBeInTheDocument()
    expect(view.queryByTestId("channel")).toBeNull()
  })
})
