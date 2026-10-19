import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@/test/react-dom-harness"
import { useChannelMessageFeed } from "./use-channel-message-feed"

const mocks = vi.hoisted(() => ({
  messages: { messages: [{ id: "read", authorId: "viewer", seq: 1 }, { id: "peer", authorId: "peer", seq: 2 }],
    readSnapshot: { channelId: "c1", lastReadMessageId: "read", lastReadSeq: 1, lastReadAt: null } as { channelId: string; lastReadMessageId: string | null; lastReadSeq: number; lastReadAt: null } | null,
    readSnapshotFetching: false, anchorReconciled: true, initialPositionKnown: true,
    entryDenied: false, initialLoadError: null as Error | null, isPending: false, isError: false, hasMoreNewer: false,
    latestSeq: 2, retryInitialLoad: vi.fn(), refetch: vi.fn(),
  },
  useMessages: vi.fn(), watermark: vi.fn(),
}))
vi.mock("./use-messages", () => ({ useMessages: (...args: unknown[]) => { mocks.useMessages(...args); return mocks.messages } }))
vi.mock("./use-channel-watermark", () => ({ useChannelWatermark: (...args: unknown[]) => mocks.watermark(...args) }))
vi.mock("./use-channel-panels", () => ({ useThreads: () => ({ threads: [], isLoading: true }), usePins: () => ({ pins: [], isLoading: true }) }))
const target = { channelId: "c1", serverId: "s1", viewerUserId: "viewer", isChildChannel: false, anchorMessageId: null }
beforeEach(() => {
  mocks.useMessages.mockClear(); mocks.watermark.mockClear(); mocks.messages.retryInitialLoad.mockClear()
  Object.assign(mocks.messages, { readSnapshot: { channelId: "c1", lastReadMessageId: "read", lastReadSeq: 1, lastReadAt: null }, readSnapshotFetching: false,
    entryDenied: false, initialLoadError: null, isPending: false, isError: false, anchorReconciled: true, initialPositionKnown: true })
})

describe("message feed consumes the entry snapshot", () => {
  it("projects NEW and unread count independently of secondary pins and threads", () => {
    const hook = renderHook(() => useChannelMessageFeed(target))
    expect(hook.result.current.newDividerBefore).toBe("peer")
    expect(hook.result.current.unreadCount).toBe(1)
    expect(hook.result.current.anchorInCache).toBe(true)
    expect(hook.result.current.threadsLoading).toBe(true)
    expect(mocks.watermark).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: "ready", confirmedSeq: 1, feedStatus: "ready" }))
    hook.unmount()
  })

  it("keeps an unresolved entry pointer pending without a second leaf-read gate", () => {
    mocks.messages.readSnapshot = null; mocks.messages.readSnapshotFetching = true; mocks.messages.initialPositionKnown = false
    const hook = renderHook(() => useChannelMessageFeed({ ...target, anchorMessageId: "deep" }))
    expect(hook.result.current.newDividerBefore).toBeUndefined()
    expect(mocks.watermark).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: "pending" }))
    expect(mocks.useMessages).toHaveBeenLastCalledWith("c1", { serverId: "s1", viewerUserId: "viewer", anchorMessageId: "deep" })
    hook.unmount()
  })

  it("stops watermark writes on denial and exposes the unified retry", () => {
    const error = Object.assign(new Error("denied"), { status: 403 })
    Object.assign(mocks.messages, { entryDenied: true, initialLoadError: error, isError: true })
    const hook = renderHook(() => useChannelMessageFeed(target))
    expect(mocks.watermark).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotStatus: "error", feedStatus: "error" }))
    hook.result.current.retryInitialLoad()
    expect(mocks.messages.retryInitialLoad).toHaveBeenCalledOnce()
    hook.unmount()
  })
})
