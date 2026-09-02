import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useChannelMessageFeed } from "./use-channel-message-feed"

const mocks = vi.hoisted(() => ({
  readState: {
    snapshot: {
      lastReadMessageId: "authoritative-anchor" as string | null,
      lastReadSeq: 2,
    } as { lastReadMessageId: string | null; lastReadSeq: number } | null,
    isFetching: false,
  },
  messages: {
    messages: [
      { id: "self", authorId: "viewer" },
      { id: "authoritative-anchor", authorId: "viewer" },
      { id: "peer", authorId: "peer" },
    ],
    anchorReconciled: true,
    latestSeq: 5,
    isPending: false,
    isError: false,
    hasMoreNewer: false,
    refetch: vi.fn(),
  },
  useMessages: vi.fn(),
  watermark: vi.fn(),
}))

vi.mock("./use-channel-read-state", () => ({
  useChannelReadStateSnapshot: () => mocks.readState,
}))
vi.mock("./use-messages", () => ({
  useMessages: (...args: unknown[]) => {
    mocks.useMessages(...args)
    return mocks.messages
  },
}))
vi.mock("./use-channel-watermark", () => ({
  useChannelWatermark: (input: unknown) => mocks.watermark(input),
}))
vi.mock("./use-channel-panels", () => ({
  useThreads: () => ({ threads: [], isLoading: false }),
  usePins: () => ({ pins: [], isLoading: false }),
}))

function Capture() {
  const result = useChannelMessageFeed({
    channelId: "channel",
    serverId: "server",
    viewerUserId: "viewer",
    isChildChannel: false,
    anchorMessageId: null,
  })
  return createElement("output", {
    "data-divider": result.newDividerBefore,
    "data-unread": result.unreadCount,
  })
}

describe("useChannelMessageFeed", () => {
  beforeEach(() => {
    mocks.readState.snapshot = {
      lastReadMessageId: "authoritative-anchor",
      lastReadSeq: 2,
    }
    mocks.readState.isFetching = false
    mocks.useMessages.mockReset()
    mocks.watermark.mockReset()
  })

  it("always revalidates a mount and reconciles the authoritative server anchor", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(Capture))
    })
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: "authoritative-anchor",
      waitForAnchor: false,
      reconcileLateAnchor: true,
      revalidateOnMount: true,
    }))
    expect(renderer!.root.findByType("output").props).toMatchObject({
      "data-divider": "peer",
      "data-unread": 3,
    })
    act(() => renderer!.unmount())
  })

  it("gates the messages request until the mount-owned server anchor resolves", () => {
    mocks.readState.snapshot = null
    mocks.readState.isFetching = true
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(Capture))
    })
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: undefined,
      waitForAnchor: false,
      reconcileLateAnchor: true,
      revalidateOnMount: true,
    }))

    mocks.readState.snapshot = {
      lastReadMessageId: "resolved-anchor",
      lastReadSeq: 7,
    }
    mocks.readState.isFetching = false
    act(() => renderer!.update(createElement(Capture)))
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      lastReadMessageId: "resolved-anchor",
      waitForAnchor: false,
    }))
    act(() => renderer!.unmount())
  })
})
