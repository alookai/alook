import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { useChannelMessageFeed } from "./use-channel-message-feed"
import { ConversationActivityContext } from "@/contexts/view-activity"

const mocks = vi.hoisted(() => ({
  messages: { messages: [{ id: "read", authorId: "viewer", seq: 1 }, { id: "peer", authorId: "peer", seq: 2 }],
    readSnapshot: { channelId: "c1", lastReadMessageId: "read", lastReadSeq: 1, lastReadAt: null } as { channelId: string; lastReadMessageId: string | null; lastReadSeq: number; lastReadAt: null } | null,
    newBoundary: { afterSeq: 1, target: { id: "peer", channelId: "c1", seq: 2, authorId: "peer" } } as { afterSeq: number; target: { id: string; channelId: string; seq: number; authorId: string } } | undefined,
    readSnapshotFetching: false, anchorReconciled: true, initialPositionKnown: true,
    entryDenied: false, initialLoadError: null as Error | null, isPending: false, isError: false, hasMoreNewer: false,
    latestSeq: 2, retryInitialLoad: vi.fn(), refetch: vi.fn(),
  },
  useMessages: vi.fn(), observer: vi.fn(),
}))
vi.mock("./use-messages", () => ({ useMessages: (...args: unknown[]) => { mocks.useMessages(...args); return mocks.messages } }))
vi.mock("./use-read-observer", () => ({ useTimelineReadObserver: (...args: unknown[]) => mocks.observer(...args) }))
vi.mock("./use-channel-panels", () => ({ useThreads: () => ({ threads: [], isLoading: true }), usePins: () => ({ pins: [], isLoading: true }) }))
const target = { channelId: "c1", serverId: "s1", viewerUserId: "viewer", anchorMessageId: null }
let owner: Awaited<ReturnType<typeof createCommunityQueryOwner>>
function Owner({ children }: { children: React.ReactNode }) { return React.createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry }, children) }
beforeEach(async () => {
  owner = await createCommunityQueryOwner("viewer")
  mocks.useMessages.mockClear(); mocks.observer.mockClear(); mocks.messages.retryInitialLoad.mockClear()
  Object.assign(mocks.messages, { readSnapshot: { channelId: "c1", lastReadMessageId: "read", lastReadSeq: 1, lastReadAt: null }, readSnapshotFetching: false,
    newBoundary: { afterSeq: 1, target: { id: "peer", channelId: "c1", seq: 2, authorId: "peer" } }, entryDenied: false, initialLoadError: null, isPending: false, isError: false, anchorReconciled: true, initialPositionKnown: true })
})

describe("message feed consumes the entry snapshot", () => {
  it("keeps the canonical feed visible while retiring the background observer scope", () => {
    function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(Owner, null, React.createElement(ConversationActivityContext, { value: false }, children))
    }
    const hook = renderHook(() => useChannelMessageFeed(target), { wrapper: Wrapper })
    expect(hook.result.current.messages).toBe(mocks.messages.messages)
    expect(mocks.useMessages).toHaveBeenLastCalledWith("c1", expect.objectContaining({ serverId: "s1" }))
    expect(mocks.observer).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: null }))
  })
  it("projects NEW and unread count independently of secondary pins and threads", () => {
    const hook = renderHook(() => useChannelMessageFeed(target), { wrapper: Owner })
    expect(hook.result.current.newDividerBefore).toBe("peer")
    expect(hook.result.current.unreadCount).toBe(1)
    expect(hook.result.current.threadsLoading).toBe(true)
    expect(mocks.observer).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: "ready", confirmedSeq: 1, feedStatus: "ready" }))
    hook.unmount()
  })

  it("keeps an unresolved entry pointer pending without a second leaf-read gate", () => {
    mocks.messages.newBoundary = undefined; mocks.messages.readSnapshot = null; mocks.messages.readSnapshotFetching = true; mocks.messages.initialPositionKnown = false
    const hook = renderHook(() => useChannelMessageFeed({ ...target, anchorMessageId: "deep" }), { wrapper: Owner })
    expect(hook.result.current.newDividerBefore).toBeUndefined()
    expect(mocks.observer).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: "pending" }))
    expect(mocks.useMessages).toHaveBeenLastCalledWith("c1", { serverId: "s1", viewerUserId: "viewer", anchorMessageId: "deep" })
    hook.unmount()
  })

  it("stops observer writes on denial and exposes the unified retry", () => {
    const error = Object.assign(new Error("denied"), { status: 403 })
    Object.assign(mocks.messages, { entryDenied: true, initialLoadError: error, isError: true })
    const hook = renderHook(() => useChannelMessageFeed(target), { wrapper: Owner })
    expect(mocks.observer).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: "error", feedStatus: "error" }))
    hook.result.current.retryInitialLoad()
    expect(mocks.messages.retryInitialLoad).toHaveBeenCalledOnce()
    hook.unmount()
  })
})
