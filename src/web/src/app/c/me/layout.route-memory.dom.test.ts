import { createElement } from "react"
import type { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestAttentionSnapshot, publishCommunityFriendDecision, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"

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
  pending: [] as Array<{
    id: string
    userId: string
    name: string
    avatar: string
    avatarVersion: number
    kind: "incoming"
  }>,
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
  ShellFrame: ({
    children,
    sidebar,
  }: {
    children: React.ReactNode
    sidebar?: () => React.ReactNode
  }) => createElement("shell-frame", null, sidebar?.(), children),
}))
vi.mock("@/components/community/shell/community-pending-frame", () => ({
  CommunityPendingFrame: (props: Record<string, unknown>) => createElement("pending-frame", props),
}))
vi.mock("@/components/community/channels/dm-route-error-frame", () => ({
  DmRouteErrorFrame: (props: Record<string, unknown>) => createElement("error-frame", props),
}))
vi.mock("@/components/community/channels/dm-sidebar", () => ({
  DmSidebar: ({ friendRequestCount }: { friendRequestCount?: number }) => createElement(
    "output",
    {
      "data-testid": "dm-sidebar",
      "data-friend-request-count": friendRequestCount ?? 0,
    },
  ),
}))
vi.mock("@/stores/community", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/community")>();
  const state = {
    setCurrentServerId: vi.fn(),
    setCurrentChannelId: vi.fn(),
    uiHandlers: { cancelPendingNavigation: mocks.cancelPendingNavigation },
  }
  return {
    ...actual,
    useCommunityStore: { getState: () => state },
    useCurrentChannelId: () => null,
  }
})
vi.mock("@/hooks/community/use-dms", () => ({
  useDms: () => ({ dms: [], isLoading: false, isPending: false }),
}))
vi.mock("@/components/community/channels/dm-route", () => ({
  DmRoute: ({ dmId }: { dmId: string }) => createElement("main", { "data-testid": "target-dm", "data-channel-id": dmId }, dmId),
}))
vi.mock("@/hooks/community/use-friends", () => ({
  useFriends: () => ({ blocked: [], pending: mocks.pending }),
  useFriendsPresence: vi.fn(),
}))
vi.mock("@/stores/community/ws", async (importOriginal) => ({ ...await importOriginal<typeof import("@/stores/community/ws")>(),
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
  isRememberableMeLocation: () => mocks.locationStatus === "remember",
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

import MeContent from "./layout"
import { DmSidebarSlot } from "@/components/community/shell/dm-sidebar-slot"
import { CommunityRouteContext } from "@/components/community/shell/community-route-context"
import { normalizeCommunityHref } from "@/lib/community/community-route"

function MeLayout({ children }: { children?: React.ReactNode }) {
  return createElement(CommunityRouteContext, { value: {
    frame: { ...normalizeCommunityHref(mocks.pathname), revision: 0 },
    navigation: {} as never,
    ownerDeleteRouteScope: undefined,
  } }, createElement(DmSidebarSlot), createElement(MeContent, null, children))
}

let layoutClient: QueryClient
function renderLayout(queryClient = layoutClient) {
  return render(createElement(
    QueryClientProvider,
    { client: queryClient, userId: "viewer-1" },
    createElement(MeLayout, null, createElement("div")),
  ))
}

describe("MeLayout route memory", () => {
  beforeEach(async () => {
    layoutClient = (await createCommunityQueryOwner("viewer-1")).client
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
    mocks.pending = []
  })

  it("commits a verified Me leaf for the active account", () => {
    renderLayout()
    expect(mocks.setLastMeLocation).toHaveBeenCalledWith("/c/me/friends")
    expect(mocks.commitLastCommunityRoute).toHaveBeenCalledWith(
      "viewer-1",
      "/c/me/friends",
    )
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it.each(["wait", "ignore"] as const)("does not write a %s route", (status) => {
    mocks.locationStatus = status
    renderLayout()
    expect(mocks.commitLastCommunityRoute).not.toHaveBeenCalled()
    expect(mocks.consumeColdEntryFailure).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it("mounts each target DM while Next children stay on the neutral root, without saving last in layout", () => {
    mocks.pathname = "/c/me/dm-a"
    mocks.dmId = "dm-a"
    const client = layoutClient
    const tree = () => createElement(QueryClientProvider, { client, userId: "viewer-1" },
      createElement(MeLayout, null, createElement("div", { "data-testid": "neutral-leaf" }, "Loading your space")))
    const rendered = render(tree())
    expect(rendered.getByTestId("target-dm").getAttribute("data-channel-id")).toBe("dm-a")
    expect(rendered.queryByTestId("neutral-leaf")).toBeNull()
    mocks.pathname = "/c/me/dm-b"
    mocks.dmId = "dm-b"
    rendered.rerender(tree())
    expect(rendered.getByTestId("target-dm").getAttribute("data-channel-id")).toBe("dm-b")
    expect(rendered.queryByText("dm-a")).toBeNull()
    expect(rendered.queryByTestId("neutral-leaf")).toBeNull()
    expect(mocks.setLastMeLocation).not.toHaveBeenCalled()
    expect(mocks.commitLastCommunityRoute).not.toHaveBeenCalled()
    rendered.unmount()
    client.clear()
  })

  it("does not commit a DM pathname while its layout params are still unresolved", () => {
    mocks.pathname = "/c/me/dm-pending"
    mocks.dmId = undefined
    mocks.locationStatus = "remember"
    renderLayout()
    expect(mocks.setLastMeLocation).not.toHaveBeenCalled()
    expect(mocks.commitLastCommunityRoute).not.toHaveBeenCalled()
  })

  it("keeps the Friends shortcut count on the shared terminal projection through failed refreshes", async () => {
    const request = {
      id: "friendship-a",
      userId: "user-a",
      name: "A",
      avatar: "A",
      avatarVersion: 1,
      kind: "incoming" as const,
    }
    mocks.pending = [request]
    const { client: queryClient, registry } = await createCommunityQueryOwner("viewer-1")
    queryClient.setQueryData(communityKeys.friends(), {
      friends: [],
      blocked: [],
      pending: [request],
    })
    queryClient.setQueryData(communityKeys.inboxUnreads(), {
      friendRequests: [{ ...request, createdAt: "2026-09-12T00:00:00.000Z" }],
      servers: [],
      dms: [],
    })
    ingestAttentionSnapshot(registry, {
      scopes: [], items: [{ id: `friend_request:${request.id}`, kind: "friend_request", sourceId: request.id, scopeId: null, messageId: null, actorUserId: request.userId, createdAt: "2026-09-12T00:00:00.000Z" }],
      included: { servers: [], channels: [], dms: [], messages: [], profiles: [{ userId: request.userId, name: request.name, discriminator: "0001", avatar: request.avatar, avatarVersion: 1 }] }, limit: 100, truncated: false,
    })
    publishCommunityFriendDecision(queryClient, request.id, "reject", { token: captureCommunityLiveSnapshotToken(queryClient), signal: undefined })

    const rendered = renderLayout(queryClient)
    await act(async () => {
      await Promise.allSettled([
        queryClient.fetchQuery({
          queryKey: communityKeys.friends(),
          queryFn: async () => { throw new Error("friends refresh failed") },
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: communityKeys.accountAttention(),
          queryFn: async () => { throw new Error("inbox refresh failed") },
          staleTime: 0,
        }),
      ])
    })

    expect(rendered.getByTestId("dm-sidebar")).toHaveAttribute(
      "data-friend-request-count",
      "0",
    )
  })
})
