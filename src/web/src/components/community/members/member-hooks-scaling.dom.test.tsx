import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CurrentUserProvider } from "@/contexts/community/current-user"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import {
  canonicalChannelMembershipRow,
  friendshipSchema,
  profileSchema,
  serverMembershipKey,
  serverMembershipSchema,
} from "@/lib/community-db/schema"
import { communityKeys } from "@/lib/query-keys"
import { useServerMembers } from "@/hooks/community/use-server-members"
import { useAddableMembers, useChannelMembers } from "@/hooks/community/use-channel-members"
import { useInvitableFriends } from "@/hooks/community/use-invitable-friends"
import type { Member } from "@/lib/community/models/people"
import { useChannelMemberViewModel } from "./channel-member-view-model"
import { MemberList } from "./member-list"

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>()
  return {
    ...actual,
    apiFetch: vi.fn(async () => ({})),
  }
})

const VIEWER_USER = {
  id: "viewer",
  email: "viewer@example.com",
  name: "Viewer",
  discriminator: "0001",
  avatar: "V",
  avatarVersion: 1,
}

async function seedMembers(count: number, serverId: string, channelId: string) {
  const { client, registry } = await createCommunityQueryOwner("viewer", {
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  const profiles = Array.from({ length: count }, (_, i) =>
    profileSchema.parse({
      id: `u-${i}`,
      name: `Member${i}`,
      discriminator: String(i).padStart(4, "0"),
      avatar: "M",
      avatarVersion: 1,
    }),
  )
  const serverMemberships = Array.from({ length: count }, (_, i) =>
    serverMembershipSchema.parse({
      id: serverMembershipKey(serverId, `u-${i}`),
      memberId: `mem-${i}`,
      serverId,
      userId: `u-${i}`,
      role: i === 0 ? "owner" : "member",
      viewer: i === 0,
    }),
  )
  const channelMemberships = Array.from({ length: count }, (_, i) =>
    canonicalChannelMembershipRow(channelId, `u-${i}`, "access", { source: "explicit" }),
  )
  const friendships = Array.from({ length: count }, (_, i) =>
    friendshipSchema.parse({
      id: `fr-${i}`,
      userId: `u-${i}`,
      kind: "accepted",
      sub: "",
    }),
  )

  await writeCommunityCollectionRows(registry, "profiles", profiles, (r) => r.id)
  await writeCommunityCollectionRows(registry, "serverMemberships", serverMemberships, (r) => r.id)
  await writeCommunityCollectionRows(registry, "channelMemberships", channelMemberships, (r) => r.id)
  await writeCommunityCollectionRows(registry, "friendships", friendships, (r) => r.id)

  const identities = Array.from({ length: count }, (_, i) => ({ id: `mem-${i}`, userId: `u-${i}` }))
  client.setQueryData(communityKeys.members(serverId), {
    pages: [{ members: identities, total: count, nextCursor: null, observed: true }],
    pageParams: [null],
  })
  client.setQueryData(communityKeys.channelMembers(channelId, "access"), {
    serverId,
    relation: "access",
    members: identities.map(({ userId }) => ({ userId })),
    creatorIds: [],
    observed: true,
  })
  client.setQueryData(communityKeys.channelAddableMembers(channelId), {
    serverId,
    relation: "access",
    members: identities,
    observed: true,
  })
  client.setQueryData(communityKeys.invitableFriends(serverId), {
    serverId,
    friendIds: friendships.map((f) => f.id),
    totalFriends: count,
    observed: true,
  })

  return { client, registry }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("member hooks scaling and callback stability", () => {
  it("scales member hooks linearly with stable callbacks, avoids JSON serialization in view model, and preserves MemberList IntersectionObserver", async () => {
    const benchmarkMemberHooks = async (count: number) => {
      const serverId = `srv-${count}`
      const channelId = `ch-${count}`
      const { client, registry } = await seedMembers(count, serverId, channelId)
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(CommunityTestProvider, { client, registry, retainOwner: true }, children)

      const view = renderHook(
        ({ tick }: { tick: number }) => ({
          tick,
          server: useServerMembers(serverId),
          channel: useChannelMembers(channelId, true, serverId, "access"),
          addable: useAddableMembers(serverId, channelId, true),
          invitable: useInvitableFriends(serverId, true),
        }),
        { wrapper, initialProps: { tick: 0 } },
      )
      await waitFor(() => {
        expect(view.result.current.server.members).toHaveLength(count)
        expect(view.result.current.channel.members).toHaveLength(count)
        expect(view.result.current.server.displayReady).toBe(true)
      })

      const someSpy = vi.spyOn(Array.prototype, "some")
      const loadMoreRefs = new Set<unknown>()
      const searchRefs = new Set<unknown>()
      for (let i = 1; i <= 10; i += 1) {
        await act(async () => {
          view.rerender({ tick: i })
        })
        loadMoreRefs.add(view.result.current.server.loadMore)
        searchRefs.add(view.result.current.server.searchMembers)
      }
      const someCalls = someSpy.mock.calls.length
      someSpy.mockRestore()
      view.unmount()
      return {
        someCalls,
        uniqueLoadMoreRefs: loadMoreRefs.size,
        uniqueSearchRefs: searchRefs.size,
      }
    }

    const small = await benchmarkMemberHooks(100)
    const large = await benchmarkMemberHooks(1000)
    expect(large.someCalls).toBeLessThanOrEqual(small.someCalls + 20)
    expect(large.uniqueLoadMoreRefs).toBe(1)
    expect(large.uniqueSearchRefs).toBe(1)

    const { client: vmClient, registry: vmRegistry } = await seedMembers(200, "srv-vm", "ch-vm")
    const vmWrapper = ({ children }: { children: ReactNode }) => (
      <CommunityTestProvider client={vmClient} registry={vmRegistry} retainOwner>
        <CurrentUserProvider initialUser={VIEWER_USER}>{children}</CurrentUserProvider>
      </CommunityTestProvider>
    )

    const vmView = renderHook(
      ({ tick }: { tick: number }) => ({
        tick,
        vm: useChannelMemberViewModel({
          serverId: "srv-vm",
          channelId: "ch-vm",
          channelName: "general",
          currentServer: { categories: [{ private: false, channels: [{ id: "ch-vm", type: "text" }] }] },
          channelInServer: { creatorId: "u-0" },
          currentChannelMeta: { parentChannelId: null, name: "general", creatorId: "u-0" },
          isChildChannel: false,
          isNotifyUnit: false,
          currentUser: VIEWER_USER,
        }),
      }),
      { wrapper: vmWrapper, initialProps: { tick: 0 } },
    )
    await waitFor(() => expect(vmView.result.current.vm.composerMembers.length).toBe(200))

    const stringifySpy = vi.spyOn(JSON, "stringify")
    for (let i = 1; i <= 5; i += 1) {
      await act(async () => {
        vmView.rerender({ tick: i })
      })
    }
    const viewModelMemberNamesStringifyCalls = stringifySpy.mock.calls.filter(
      ([arg]) => Array.isArray(arg) && arg.length === 200 && typeof arg[0] === "object" && arg[0] !== null && "userId" in arg[0],
    ).length
    stringifySpy.mockRestore()
    vmView.unmount()
    expect(viewModelMemberNamesStringifyCalls).toBe(0)

    let ioConstructed = 0
    let ioDisconnected = 0
    const OriginalIO = window.IntersectionObserver
    class CountingIntersectionObserver {
      constructor() { ioConstructed += 1 }
      observe() {}
      unobserve() {}
      disconnect() { ioDisconnected += 1 }
      takeRecords() { return [] }
      root = null
      rootMargin = ""
      thresholds = []
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      writable: true,
      configurable: true,
      value: CountingIntersectionObserver,
    })

    const { client: ioClient, registry: ioRegistry } = await seedMembers(20, "srv-io", "ch-io")
    const ioMembers: Member[] = Array.from({ length: 20 }, (_, i) => ({
      id: `mem-${i}`,
      userId: `u-${i}`,
      name: `Member${i}`,
      discriminator: String(i).padStart(4, "0"),
      avatar: "M",
      avatarVersion: 1,
      role: "member",
      status: "online",
      sub: "",
    }))
    ioClient.setQueryData(communityKeys.members("srv-io"), {
      pages: [{ members: ioMembers.map(({ id, userId }) => ({ id, userId })), total: 100, hasMore: true, cursor: "cursor-2", observed: true }],
      pageParams: [null],
    })

    function MemberListHost({ tick }: { tick: number }) {
      const hook = useServerMembers("srv-io")
      return createElement("div", { "data-tick": tick }, createElement(MemberList, {
        members: hook.members,
        scopeId: "srv-io",
        hasMore: hook.hasMore,
        loadingMore: false,
        onLoadMore: hook.loadMore,
        onSearch: hook.searchMembers,
      }))
    }

    let mlView: ReturnType<typeof render> | null = null
    try {
      mlView = render(
        <CommunityTestProvider client={ioClient} registry={ioRegistry} retainOwner>
          <CurrentUserProvider initialUser={VIEWER_USER}>
            <MemberListHost tick={0} />
          </CurrentUserProvider>
        </CommunityTestProvider>,
      )
      await waitFor(() => expect(ioConstructed).toBeGreaterThanOrEqual(1))
      const ioBeforeRerenders = ioConstructed
      const ioDiscBefore = ioDisconnected
      for (let i = 1; i <= 5; i += 1) {
        await act(async () => {
          mlView!.rerender(
            <CommunityTestProvider client={ioClient} registry={ioRegistry} retainOwner>
              <CurrentUserProvider initialUser={VIEWER_USER}>
                <MemberListHost tick={i} />
              </CurrentUserProvider>
            </CommunityTestProvider>,
          )
        })
      }
      expect(ioConstructed - ioBeforeRerenders).toBe(0)
      expect(ioDisconnected - ioDiscBefore).toBe(0)
    } finally {
      mlView?.unmount()
      Object.defineProperty(globalThis, "IntersectionObserver", {
        writable: true,
        configurable: true,
        value: OriginalIO,
      })
    }
  })
})
