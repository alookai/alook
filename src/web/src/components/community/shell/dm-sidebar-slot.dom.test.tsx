import { createElement, useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { RemoteIdentityImage } from "@/components/remote-image/remote-image"
import { DmSidebarSlot } from "./dm-sidebar-slot"

const mocks = vi.hoisted(() => ({
  scope: "server",
  avatar: "/peer?v=1",
  peer: "peer-a",
  reads: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock("./community-route-context", () => ({
  useCommunityRouteFrame: () => ({ frame: {
    scope: { kind: mocks.scope },
    pathname: mocks.scope === "me" ? "/c/me/friends" : "/c/channels/server",
  } }),
}))
vi.mock("@/stores/community/runtime", () => ({
  useCommunityRuntime: () => ({ ui: {
    get: () => ({ uiHandlers: { navigatePath: mocks.navigate } }),
    actions: { setCurrentChannelId: vi.fn() },
  } }),
}))
vi.mock("@/stores/community", () => ({ useCurrentChannelId: () => null }))
vi.mock("@/hooks/community/use-dms", () => ({
  useDms: () => {
    mocks.reads()
    useEffect(() => {
      mocks.subscribe()
      return () => { mocks.unsubscribe() }
    }, [])
    return { dms: [{ userId: mocks.peer, avatar: mocks.avatar }], isLoading: false }
  },
}))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriends: () => ({ blocked: [] }),
  useFriendsPresence: () => undefined,
}))
vi.mock("@/hooks/community/use-inbox", () => ({
  useInboxUnreads: () => ({ friendRequests: [] }),
}))
vi.mock("@/lib/observability/regions", () => ({ useObservedRegion: vi.fn() }))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebar: ({ dms }: { dms: Array<{ userId: string; avatar: string }> }) => <aside>
    <input aria-label="Sidebar state" defaultValue="retained" />
    <RemoteIdentityImage src={dms[0].avatar} identityKey={dms[0].userId} alt="Peer" />
  </aside>,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope = "server"
  mocks.avatar = "/peer?v=1"
  mocks.peer = "peer-a"
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(48)
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(48)
})
afterEach(() => { vi.restoreAllMocks() })

describe("account-scoped DM sidebar Activity", () => {
  it("starts at the first Me visit, preserves real DOM and releases Effects while away", () => {
    const rendered = render(<DmSidebarSlot />)
    expect(mocks.reads).not.toHaveBeenCalled()
    expect(rendered.container.querySelector("aside")).toBeNull()
    mocks.scope = "me"
    rendered.rerender(<DmSidebarSlot />)
    const image = rendered.container.querySelector("img")!
    const input = rendered.getByRole("textbox") as HTMLInputElement
    input.value = "local state"
    expect(image).toHaveClass("opacity-100")
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)

    mocks.scope = "server"
    rendered.rerender(<DmSidebarSlot />)
    expect(image.isConnected).toBe(true)
    expect(image).not.toBeVisible()
    expect(rendered.queryByRole("textbox")).toBeNull()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)

    mocks.scope = "me"
    rendered.rerender(<DmSidebarSlot />)
    expect(rendered.container.querySelector("img")).toBe(image)
    expect(rendered.container.querySelectorAll("aside")).toHaveLength(1)
    expect(rendered.getByRole("textbox")).toBe(input)
    expect(input.value).toBe("local state")
    expect(image).toHaveClass("opacity-100")
    expect(mocks.subscribe).toHaveBeenCalledTimes(2)
  })

  it("obeys a hidden pending checkpoint without discarding the displayed avatar", () => {
    mocks.scope = "me"
    const rendered = render(<DmSidebarSlot visible />)
    const image = rendered.container.querySelector("img")!
    rendered.rerender(<DmSidebarSlot visible={false} />)
    expect(image).not.toBeVisible()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    rendered.rerender(<DmSidebarSlot visible />)
    expect(rendered.container.querySelector("img")).toBe(image)
    expect(image).toBeVisible()
    expect(image).toHaveClass("opacity-100")
  })

  it("discards the old subtree at the existing account-key boundary", () => {
    mocks.scope = "me"
    const rendered = render(createElement(DmSidebarSlot, { key: "account-a" }))
    const image = rendered.container.querySelector("img")!
    mocks.scope = "server"
    mocks.peer = "peer-b"
    mocks.avatar = "/other-peer?v=2"
    rendered.rerender(createElement(DmSidebarSlot, { key: "account-b" }))
    expect(image.isConnected).toBe(false)
    expect(rendered.container.querySelector("aside")).toBeNull()
    mocks.scope = "me"
    rendered.rerender(createElement(DmSidebarSlot, { key: "account-b" }))
    const replacement = rendered.container.querySelector("img")!
    expect(replacement).not.toBe(image)
    expect(replacement).toHaveAttribute("src", "/other-peer?v=2")
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
  })
})
