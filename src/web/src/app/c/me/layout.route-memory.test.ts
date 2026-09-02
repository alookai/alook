import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pathname: "/c/me/friends",
  dmId: undefined as string | undefined,
  dmStatus: "idle" as "idle" | "pending" | "present" | "missing" | "error",
  locationStatus: "remember" as "ignore" | "wait" | "remember" | "stale",
  replace: vi.fn(),
  cancelPendingNavigation: vi.fn(),
  setLastMeLocation: vi.fn(),
  clearLastMeLocation: vi.fn(),
  commitLastCommunityRoute: vi.fn(),
  consumeColdEntryFailure: vi.fn(() => false),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, prefetch: vi.fn() }),
  usePathname: () => mocks.pathname,
  useParams: () => ({ dmId: mocks.dmId }),
  useSelectedLayoutSegments: () => mocks.pathname.slice("/c/me/".length).split("/").filter(Boolean),
}))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer-1" }),
}))
vi.mock("@/components/community/shell/shell-frame", () => ({
  ShellFrame: ({ children }: { children: React.ReactNode }) => createElement("shell-frame", null, children),
}))
vi.mock("@/components/community/shell/community-pending-frame", () => ({
  CommunityPendingFrame: (props: Record<string, unknown>) => createElement("pending-frame", props),
}))
vi.mock("@/components/community/channels/dm-route-error-frame", () => ({
  DmRouteErrorFrame: (props: Record<string, unknown>) => createElement("error-frame", props),
}))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebar: () => null,
}))
vi.mock("@/stores/community", () => {
  const state = {
    setCurrentServerId: vi.fn(),
    setCurrentChannelId: vi.fn(),
    uiHandlers: { cancelPendingNavigation: mocks.cancelPendingNavigation },
  }
  return {
    useCommunityStore: { getState: () => state },
    useCurrentChannelId: () => null,
  }
})
vi.mock("@/hooks/community/use-dms", () => ({
  useDms: () => ({ dms: [], isLoading: false, isPending: false, isFetching: false }),
}))
vi.mock("@/hooks/community/use-dm-route-verification", () => ({
  useDmRouteVerification: () => ({ status: mocks.dmStatus, retry: vi.fn(), retrying: false }),
}))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriends: () => ({ blocked: [] }),
  useFriendsPresence: vi.fn(),
}))
vi.mock("@/stores/community/ws", () => ({
  useCommunityWsStore: (selector: (state: { profilesByUserId: Map<string, unknown> }) => unknown) =>
    selector({ profilesByUserId: new Map() }),
}))
vi.mock("@/lib/community/profile-read", () => ({
  readCommunityProfile: () => ({
    name: "Name",
    discriminator: "0001",
    avatar: "N",
    avatarVersion: 0,
    presence: "offline",
  }),
}))
vi.mock("@/lib/community/last-me-location", () => ({
  ME_ROOT: "/c/me",
  resolveMeLocationStatus: () => mocks.locationStatus,
  setLastMeLocation: (...args: unknown[]) => mocks.setLastMeLocation(...args),
  getLastMeLeaf: () => mocks.dmId,
  meLeafFromPathname: () => mocks.dmId,
  clearLastMeLocation: (...args: unknown[]) => mocks.clearLastMeLocation(...args),
}))
vi.mock("@/lib/community/last-community-route", () => ({
  COMMUNITY_COLD_ENTRY_FALLBACK: "/c/me/machines",
  commitLastCommunityRoute: (...args: unknown[]) => mocks.commitLastCommunityRoute(...args),
  consumeCommunityColdEntryFailure: (...args: unknown[]) => mocks.consumeColdEntryFailure(...args),
}))

import MeLayout from "./layout"

function render() {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(createElement(MeLayout, null, createElement("child")))
  })
  return renderer
}

describe("MeLayout route memory", () => {
  beforeEach(() => {
    mocks.pathname = "/c/me/friends"
    mocks.dmId = undefined
    mocks.dmStatus = "idle"
    mocks.locationStatus = "remember"
    mocks.replace.mockClear()
    mocks.cancelPendingNavigation.mockClear()
    mocks.setLastMeLocation.mockClear()
    mocks.clearLastMeLocation.mockClear()
    mocks.commitLastCommunityRoute.mockClear()
    mocks.consumeColdEntryFailure.mockReset()
    mocks.consumeColdEntryFailure.mockReturnValue(false)
  })

  it("commits a verified Me leaf for the active account", () => {
    render()
    expect(mocks.setLastMeLocation).toHaveBeenCalledWith("/c/me/friends")
    expect(mocks.commitLastCommunityRoute).toHaveBeenCalledWith(
      "viewer-1",
      "/c/me/friends",
    )
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it.each(["wait", "ignore"] as const)("does not write a %s route", (status) => {
    mocks.locationStatus = status
    render()
    expect(mocks.commitLastCommunityRoute).not.toHaveBeenCalled()
    expect(mocks.consumeColdEntryFailure).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("clears a matching failed cold-entry DM and falls back to Machines", () => {
    mocks.pathname = "/c/me/dm-missing"
    mocks.dmId = "dm-missing"
    mocks.dmStatus = "missing"
    mocks.locationStatus = "stale"
    mocks.consumeColdEntryFailure.mockReturnValue(true)
    render()
    expect(mocks.clearLastMeLocation).toHaveBeenCalledTimes(1)
    expect(mocks.cancelPendingNavigation).toHaveBeenCalledTimes(1)
    expect(mocks.consumeColdEntryFailure).toHaveBeenCalledWith(
      "viewer-1",
      "/c/me/dm-missing",
    )
    expect(mocks.replace).toHaveBeenCalledWith("/c/me/machines")
  })

  it("keeps the existing Me-root fallback for an ordinary invalid deep link", () => {
    mocks.pathname = "/c/me/dm-missing"
    mocks.dmId = "dm-missing"
    mocks.dmStatus = "missing"
    mocks.locationStatus = "stale"
    render()
    expect(mocks.replace).toHaveBeenCalledWith("/c/me")
  })
})
