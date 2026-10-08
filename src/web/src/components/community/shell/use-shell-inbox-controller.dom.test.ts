import "fake-indexeddb/auto"
import { createElement } from "react"
import { type QueryClient, useQueryClient, useIsRestoring } from "@tanstack/react-query"
import { act, waitFor, renderHook, render as rtlRender } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryProvider } from "@/app/c/QueryProvider"
import { communityKeys } from "@/lib/query-keys"
import { getCanonicalCommunityChannels, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { channelMetadataOptions, isChannelMetadataTokenCurrent } from "@/hooks/community/channel-metadata"
import { useChannelMetadata } from "@/hooks/community/use-channel-metadata"
import { getConversationNavigationProof, useConversationNavigationGate } from "@/lib/community/conversation-navigation-proof"
import type { Mention, UnreadDm, UnreadServer } from "@/lib/community/models/inbox"
import { useShellInboxController } from "./use-shell-inbox-controller"

const order: string[] = []
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "viewer" } }, isPending: false, error: null }),
  currentSessionViewer: () => "viewer",
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
const mocks = vi.hoisted(() => ({
  markedEnabled: [] as boolean[],
  refetchAttention: vi.fn(),
  markAll: vi.fn(),
  deleteMention: vi.fn(),
  unmark: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  verifyDm: vi.fn(),
  armOpener: vi.fn(),
  clearOpener: vi.fn(),
  terminateOpener: vi.fn(),
  cancelProof: vi.fn(),
  warmup: vi.fn(),
  begin: vi.fn(),
  submitted: vi.fn(),
  rollback: vi.fn(),
  close: vi.fn(),
  onOpenChange: vi.fn(),
  latestEpoch: 0,
}))

const unreadDm: UnreadDm = {
  channelId: "dm1",
  otherUserId: "u2",
  otherUserName: "Peer",
  otherUserDiscriminator: "2222",
  otherUserAvatar: "P",
  lastMessageAt: "2026-08-24T00:00:00.000Z",
}

const server: UnreadServer = {
  serverId: "s1",
  serverName: "Server",
  channels: [{
    channelId: "c1",
    channelName: "Channel",
    lastMessageAt: "2026-08-24T00:00:00.000Z",
    mentionCount: 0,
    hasDirectUnread: true,
    children: [{
      channelId: "child",
      channelName: "Child",
      lastMessageAt: "2026-08-24T00:00:00.000Z",
      mentionCount: 0,
      parentChannelId: "c1",
      openerMessageId: "opener-7",
      openerSeq: 7,
      openerUnread: true,
    }],
  }],
}

const mention: Mention = {
  id: "m1",
  server: "Server",
  serverId: "s1",
  channel: "Channel",
  channelId: "c1",
  m: { id: "msg1", seq: 4 } as Mention["m"],
}

vi.mock("@/hooks/community/use-inbox", () => ({
  useInboxAttention: () => ({
    friendRequests: [{
      id: "fr_1",
      userId: "requester",
      name: "Ada",
      avatar: "A",
      avatarVersion: 1,
      createdAt: "2026-09-12T01:00:00Z",
    }],
    servers: [server],
    dms: [unreadDm],
    mentions: [mention],
    isLoading: false,
    isInitialError: false,
    hasUnread: true,
    hasMention: true,
    hasOutstandingFriendRequest: true,
    exactAttentionCount: 4,
    refetch: mocks.refetchAttention,
  }),
  useInboxMarked: (enabled: boolean) => {
    mocks.markedEnabled.push(enabled)
    return { marked: [], isLoading: false }
  },
}))
vi.mock("@/hooks/community/use-inbox-auto-collapse", () => ({
  useInboxAutoCollapse: () => ({
    open: true,
    onOpenChange: (...args: unknown[]) => mocks.onOpenChange(...args),
    beginProjection: (...args: unknown[]) => mocks.begin(...args),
    markProjectionSubmitted: (...args: unknown[]) => mocks.submitted(...args),
    rollbackProjection: (...args: unknown[]) => mocks.rollback(...args),
    closeWithoutProjection: (...args: unknown[]) => mocks.close(...args),
    isProjected: () => false,
    isLatestProjection: (epoch: number) => epoch === mocks.latestEpoch,
  }),
}))
vi.mock("@/hooks/community/mutations", async () => {
  const { useMutation } = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  function useRequest(action: "accept" | "reject") {
    const command = useMutation({ mutationKey: ["community", "friend-request", action], gcTime: Infinity, mutationFn: (input: { friendshipId: string }) => mocks[action](input) })
    return command
  }
  return {
  useMarkAllInboxRead: () => ({ mutate: mocks.markAll }),
  useDeleteMention: () => ({ mutate: mocks.deleteMention }),
  useUnmarkMessage: () => ({ mutate: mocks.unmark }),
  useAcceptFriendRequest: () => useRequest("accept"),
  useRejectFriendRequest: () => useRequest("reject"),
  }
})
vi.mock("@/hooks/community/channel-route-verification", () => ({
  startChannelRouteVerification: (...args: unknown[]) => mocks.verifyDm(...args),
}))
vi.mock("@/lib/community/conversation-navigation-warmup", () => ({
  startConversationNavigationWarmup: (...args: unknown[]) => mocks.warmup(...args),
}))
vi.mock("@/lib/community/conversation-navigation-proof", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/community/conversation-navigation-proof")>(),
  cancelConversationNavigationProof: (...args: unknown[]) => mocks.cancelProof(...args),
}))
vi.mock("@/hooks/community/thread-opener-read-handoff", () => ({
  armThreadOpenerReadHandoff: (...args: unknown[]) => mocks.armOpener(...args),
  clearThreadOpenerReadHandoff: (...args: unknown[]) => mocks.clearOpener(...args),
}))
vi.mock("@/hooks/community/inbox-read-reservation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/hooks/community/inbox-read-reservation")>()
  return {
    ...original,
    terminateThreadOpenerReservationHandoff: (...args: unknown[]) => mocks.terminateOpener(...args),
  }
})

type Result = ReturnType<typeof useShellInboxController>

function Capture({ options, onResult }: {
  options: Omit<Parameters<typeof useShellInboxController>[0], "queryClient">
  onResult: (result: Result, client: QueryClient, restoring: boolean) => void
}) {
  const queryClient = useQueryClient()
  const restoring = useIsRestoring()
  onResult(useShellInboxController({ ...options, queryClient }), queryClient, restoring)
  return null
}

async function renderController(
  _initialDmCache: undefined = undefined,
  push?: (href: string) => void,
) {
  const pushed: string[] = []
  const router = {
    push: (href: string) => {
      order.push("push")
      pushed.push(href)
      push?.(href)
    },
    replace: vi.fn(),
    prefetch: vi.fn(),
  }
  let queryClient!: QueryClient
  let restoring = true
  const cancelPendingNavigation = vi.fn(() => { order.push("cancel") })
  let current!: Result
  await act(async () => {
    rtlRender(createElement(
      QueryProvider,
      { userId: "viewer" },
      createElement(Capture, {
        options: {
          router,
          cancelPendingNavigation,
          publishedHref: "/c/channels/s1",
          navigationPending: false,
          pendingHref: null,
          viewerId: "viewer",
          accessEpoch: 0,
        },
        onResult: (result, client, pending) => { current = result; queryClient = client; restoring = pending },
      }),
    ))
  })
  await waitFor(() => expect(restoring).toBe(false))
  act(() => { queryClient.setQueryData(communityKeys.dms(), { ids: [] }) })
  return {
    get current() { return current },
    order,
    pushed,
    queryClient,
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe("useShellInboxController", () => {
  beforeEach(() => {
    order.length = 0
    mocks.markedEnabled.length = 0
    for (const mock of [
      mocks.markAll,
      mocks.refetchAttention,
      mocks.deleteMention,
      mocks.unmark,
      mocks.accept,
      mocks.reject,
      mocks.verifyDm,
      mocks.armOpener,
      mocks.clearOpener,
      mocks.terminateOpener,
      mocks.cancelProof,
      mocks.warmup,
      mocks.begin,
      mocks.submitted,
      mocks.rollback,
      mocks.close,
      mocks.onOpenChange,
    ]) mock.mockReset()
    mocks.latestEpoch = 0
    mocks.begin.mockImplementation(() => {
      order.push("project")
      mocks.latestEpoch += 1
      return mocks.latestEpoch
    })
    mocks.submitted.mockImplementation((epoch: number) => {
      order.push("submitted")
      return epoch === mocks.latestEpoch
    })
    mocks.rollback.mockImplementation(() => { order.push("rollback"); return true })
    mocks.close.mockImplementation(() => { order.push("close"); return true })
    mocks.onOpenChange.mockImplementation(() => { order.push("reopen") })
    mocks.clearOpener.mockImplementation(() => { order.push("clear") })
    mocks.armOpener.mockImplementation(() => {
      order.push("arm")
      return "/c/channels/s1/child?inboxThreadOpener=nonce-1"
    })
    mocks.verifyDm.mockImplementation(() => {
      order.push("verify")
      return Promise.resolve("present")
    })
    mocks.warmup.mockReturnValue(99)
    mocks.accept.mockResolvedValue(undefined)
    mocks.reject.mockResolvedValue(undefined)
  })

  it("includes friend requests in the global dot while keeping navigation and actions read-neutral", async () => {
    const hook = await renderController()
    expect(hook.current.hasUnread).toBe(true)
    expect(hook.current.unreadCount).toBe(4)
    expect(hook.current.popoverProps.hasProjectedUnreads).toBe(true)
    expect(hook.current.popoverProps.friendRequests).toHaveLength(1)

    hook.current.popoverProps.onOpenFriendRequests?.()
    expect(hook.pushed).toEqual(["/c/me/friends?tab=new"])
    expect(mocks.begin).not.toHaveBeenCalled()

    const item = hook.current.popoverProps.friendRequests?.[0]
    expect(item).toBeDefined()
    await act(async () => hook.current.popoverProps.onAcceptFriendRequest?.(item!))
    expect(mocks.accept).toHaveBeenCalledWith({ friendshipId: "fr_1" })
    expect(mocks.reject).not.toHaveBeenCalled()
  })

  it("routes a rejected request through its keyed retry", async () => {
    mocks.reject
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
    const hook = await renderController()
    const item = hook.current.popoverProps.friendRequests?.[0]
    expect(item).toBeDefined()

    await act(async () => hook.current.popoverProps.onRejectFriendRequest?.(item!))
    await waitFor(() => expect(hook.current.popoverProps.friendRequests?.[0]).toMatchObject({ action: "reject", status: "error" }))
    const failed = hook.current.popoverProps.friendRequests?.[0]
    expect(failed).toMatchObject({ action: "reject", status: "error" })
    await act(async () => hook.current.popoverProps.onRetryFriendRequest?.(failed!))

    expect(mocks.reject).toHaveBeenCalledTimes(2)
    expect(mocks.reject).toHaveBeenNthCalledWith(1, { friendshipId: "fr_1" })
    expect(mocks.reject).toHaveBeenNthCalledWith(2, { friendshipId: "fr_1" })
  })

  it("reopens Inbox when friend-request navigation throws", async () => {
    const hook = await renderController(undefined, () => { throw new Error("push failed") })
    order.length = 0

    expect(() => hook.current.popoverProps.onOpenFriendRequests?.()).toThrow("push failed")
    expect(order).toEqual(["close", "cancel", "push", "cancel", "reopen"])
    expect(mocks.onOpenChange).toHaveBeenCalledWith(true)
  })

  it("keeps Marked lazy and latches it after first selection", async () => {
    const hook = await renderController()
    expect(mocks.markedEnabled.at(-1)).toBe(false)
    await act(async () => hook.current.popoverProps.onMarkedTabSelected?.())
    expect(mocks.markedEnabled.at(-1)).toBe(true)
  })

  it("retries the owned attention query from the popover", async () => {
    const hook = await renderController()

    hook.current.popoverProps.onRetryAttention?.()

    expect(mocks.refetchAttention).toHaveBeenCalledTimes(1)
  })

  it("retains controlled tab and per-tab scroll offsets without data work", async () => {
    const hook = await renderController()
    expect(hook.current.popoverProps.activeTab).toBe("unreads")

    await act(async () => {
      hook.current.popoverProps.onScrollOffsetChange?.("unreads", 42)
      hook.current.popoverProps.onActiveTabChange?.("marked")
    })

    expect(hook.current.popoverProps.activeTab).toBe("marked")
    expect(hook.current.popoverProps.getScrollOffset?.("unreads")).toBe(42)
    expect(hook.current.popoverProps.getScrollOffset?.("marked")).toBe(0)
    expect(mocks.markedEnabled.at(-1)).toBe(true)
    expect(mocks.markAll).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("closes/projects before cancel and pushes a direct channel without data work", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      true,
    ))
    expect(order).toEqual(["project", "cancel", "clear", "push", "submitted"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1"])
  })

  it("opens a structural-only parent without projecting any unread", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      false,
    ))
    expect(order).toEqual(["close", "cancel", "clear", "push"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1"])
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("reopens a structural-only parent surface when navigation throws", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    order.length = 0
    await expect(act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      false,
    ))).rejects.toThrow("push failed")
    expect(order).toEqual(["close", "cancel", "clear", "push", "cancel", "reopen"])
    expect(mocks.onOpenChange).toHaveBeenCalledWith(true)
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("joins protected re-entry before proof capture through the real Inbox warmup, push and afterPush chain", async () => {
    const actualWarmup = await vi.importActual<typeof import("@/lib/community/conversation-navigation-warmup")>("@/lib/community/conversation-navigation-warmup")
    const actualVerifier = await vi.importActual<typeof import("@/hooks/community/channel-route-verification")>("@/hooks/community/channel-route-verification")
    mocks.warmup.mockImplementation(actualWarmup.startConversationNavigationWarmup)
    mocks.verifyDm.mockImplementation(actualVerifier.startChannelRouteVerification)
    const metadata = { id: "dm1", serverId: null, type: "dm", name: null,
      parentChannelId: null, parentMessageId: null, creatorId: null, archived: false,
      lastMessageAt: null, createdAt: "2026-10-02T00:00:00Z" }
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })
    const requests: Array<{ path: string; signal: AbortSignal; resolve: (value: Response) => void }> = []
    let held = false
    vi.stubGlobal("fetch", vi.fn((path: string, options: RequestInit) => !held
      ? Promise.resolve(json(metadata))
      : new Promise<Response>((resolve) => requests.push({ path, signal: options.signal!, resolve }))))
    const hook = await renderController()
    const registry = getCommunityDbRegistry(hook.queryClient)!
    await hook.queryClient.query(channelMetadataOptions(hook.queryClient, null, "dm1"))
    const wrapper = ({ children }: React.PropsWithChildren) => createElement(CommunityTestProvider, { client: hook.queryClient, registry, retainOwner: true }, children)
    const prior = renderHook(() => useChannelMetadata(null, "dm1"), { wrapper })
    const oldProof = prior.result.current.data!.readProof!
    act(() => retireCommunityChannelReading(registry, "dm1", { reason: "read-denied" }))
    expect(prior.result.current.denied).toBe(true)
    held = true
    await act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(hook.pushed).toEqual(["/c/me/dm1"])
    expect(mocks.submitted).toHaveBeenCalledOnce()
    expect(mocks.verifyDm).toHaveBeenCalledTimes(2)
    expect(getConversationNavigationProof(hook.queryClient)?.status).toBe("warming")
    expect(registry.runtime.ws.get().channelAccessScopes.get("dm1")).toMatchObject({ generation: 2, revoked: true })
    expect(isChannelMetadataTokenCurrent(oldProof)).toBe(false)
    const authority = requests.find((request) => new URL(request.path, "https://alook.test").pathname === "/api/community/channels/dm1")!
    const resource = hook.queryClient.getQueryCache().find({ queryKey: communityKeys.channelMeta(null, "dm1"), exact: true })!
    prior.unmount()
    expect(resource.getObserversCount()).toBe(2)
    expect(authority.signal.aborted).toBe(false)
    const current = renderHook(() => ({ metadata: useChannelMetadata(null, "dm1"), gate: useConversationNavigationGate(hook.queryClient, "viewer", "dm1", 0) }), { wrapper })
    expect(current.result.current.metadata.canRead).toBe(false)
    expect(current.result.current.gate.allowed).toBe(false)
    await act(async () => authority.resolve(json(metadata)))
    await waitFor(() => expect(current.result.current.metadata.canRead).toBe(true))
    await act(async () => {
      requests.find((request) => request.path.includes("/read-state"))!.resolve(json({ lastReadMessageId: null, lastReadAt: null, lastReadSeq: 0 }))
      requests.find((request) => request.path.includes("/messages"))!.resolve(json({ messages: [], hasMore: false, surfaceReceipt: { channelId: "dm1", surfaceKind: "dm" } }))
    })
    await waitFor(() => expect(current.result.current.gate.allowed).toBe(true))
    expect(registry.runtime.ws.get().channelAccessScopes.get("dm1")).toMatchObject({ generation: 2, revoked: false })
    expect(requests).toHaveLength(3)
    await waitFor(() => expect(resource.getObserversCount()).toBe(1))
    current.unmount()
  })

  it("upserts a DM only after projection/cancel and verifies only after push", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm))
    expect(order).toEqual([
      "project",
      "cancel",
      "clear",
      "push",
      "submitted",
      "verify",
    ])
    expect(getCanonicalCommunityChannels(hook.queryClient)).toContainEqual(expect.objectContaining({ id: "dm1", type: "dm" }))
    expect(hook.queryClient.getQueryData(communityKeys.dms())).toEqual({ ids: [] })
    expect(hook.pushed).toEqual(["/c/me/dm1"])
  })

  it("arms an exact unread opener after stale setup is cleared and before push", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenThread?.(
      server,
      server.channels[0]!,
      server.channels[0]!.children[0]!,
    ))
    expect(order).toEqual(["project", "cancel", "clear", "arm", "push", "submitted"])
    expect(hook.pushed).toEqual(["/c/channels/s1/child?inboxThreadOpener=nonce-1"])
  })

  it("leaves an invalid Mention completely untouched", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMention?.({ id: "bad" } as Mention))
    expect(order).toEqual([])
  })

  it("projects a valid Mention and submits its channel synchronously", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMention?.(mention))
    expect(order).toEqual(["project", "cancel", "clear", "push", "submitted"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1?msg=msg1"])
  })

  it("closes Marked without creating a projection", async () => {
    const hook = await renderController()
    order.length = 0
    await act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk1",
      serverId: "s1",
      channelId: "c1",
      m: { id: "message-7", seq: 7 },
    } as never))
    expect(order).toEqual(["close", "cancel", "clear", "push"])
    expect(hook.pushed).toEqual(["/c/channels/s1/c1?seq=7"])
    expect(mocks.warmup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      href: "/c/channels/s1/c1?seq=7",
      anchorMessageId: "message-7",
    }), 0)
    expect(mocks.begin).not.toHaveBeenCalled()
  })

  it("keeps the exact seq target for a DM Marked row", async () => {
    const hook = await renderController()
    await act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk-dm",
      serverId: null,
      channelId: "dm1",
      m: { id: "dm-message", seq: 9 },
    } as never))
    expect(hook.pushed).toEqual(["/c/me/dm1?seq=9"])
  })

  it("cancels the Marked proof and reopens Inbox when navigation throws", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    await expect(act(async () => hook.current.popoverProps.onOpenMarked?.({
      id: "mk1",
      serverId: "s1",
      channelId: "c1",
      m: { id: "message-7", seq: 7 },
    } as never))).rejects.toThrow("push failed")
    expect(mocks.cancelProof).toHaveBeenCalledWith(expect.anything(), 99)
    expect(mocks.onOpenChange).toHaveBeenCalledWith(true)
  })

  it("rolls back and reopens the latest projection when push throws", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    order.length = 0
    await expect(act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      true,
    ))).rejects.toThrow("push failed")
    expect(order).toEqual([
      "project",
      "cancel",
      "clear",
      "push",
      "cancel",
      "rollback",
    ])
    expect(mocks.rollback).toHaveBeenCalledWith(1, true)
  })

  it("terminates only the exact thread handoff and never verifies a failed DM push", async () => {
    const error = new Error("push failed")
    const hook = await renderController(undefined, () => { throw error })
    await expect(act(async () => hook.current.popoverProps.onOpenThread?.(
      server,
      server.channels[0]!,
      server.channels[0]!.children[0]!,
    ))).rejects.toThrow("push failed")
    expect(mocks.terminateOpener).toHaveBeenCalledWith(expect.anything(), "nonce-1")

    order.length = 0
    await expect(act(async () => hook.current.popoverProps.onOpenDm?.(unreadDm)))
      .rejects.toThrow("push failed")
    expect(mocks.verifyDm).not.toHaveBeenCalled()
  })

  it("lets re-entrant B keep ownership when stale A throws afterward", async () => {
    const serverB: UnreadServer = {
      ...server,
      channels: [{
        ...server.channels[0]!,
        channelId: "c2",
        channelName: "Channel B",
        children: [],
      }],
    }
    const holder: { hook?: Awaited<ReturnType<typeof renderController>> } = {}
    const hook = await renderController(undefined, (href) => {
      if (href !== "/c/channels/s1/c1") return
      holder.hook!.current.popoverProps.onOpenChannel?.(
        serverB,
        serverB.channels[0]!,
        true,
      )
      throw new Error("stale A failed")
    })
    holder.hook = hook
    order.length = 0

    await expect(act(async () => hook.current.popoverProps.onOpenChannel?.(
      server,
      server.channels[0]!,
      true,
    ))).rejects.toThrow("stale A failed")

    expect(hook.pushed).toEqual([
      "/c/channels/s1/c1",
      "/c/channels/s1/c2",
    ])
    expect(mocks.latestEpoch).toBe(2)
    expect(mocks.rollback).not.toHaveBeenCalled()
    expect(order.filter((item) => item === "cancel")).toHaveLength(2)
  })

  it("wires mark/delete/unmark payloads", async () => {
    const hook = await renderController()
    await act(async () => hook.current.popoverProps.onMarkAllRead?.())
    await act(async () => hook.current.popoverProps.onDeleteMention?.("mn1"))
    await act(async () => hook.current.popoverProps.onUnmark?.("msg1"))
    expect(mocks.markAll).toHaveBeenCalledWith()
    expect(mocks.deleteMention).toHaveBeenCalledWith({ mentionId: "mn1" })
    expect(mocks.unmark).toHaveBeenCalledWith({ messageId: "msg1" })
  })
})
