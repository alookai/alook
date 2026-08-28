import { createElement } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useChannelMessageFeed } from "./use-channel-message-feed"

const mocks = vi.hoisted(() => ({
  readState: {
    snapshot: { lastReadMessageId: null as string | null, lastReadSeq: 2 },
    isFetching: false,
  },
  messages: {
    messages: [
      { id: "self", authorId: "viewer" },
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

function Capture({ preferCachedWindowOnMount = false }: { preferCachedWindowOnMount?: boolean }) {
  const result = useChannelMessageFeed({
    channelId: "channel",
    serverId: "server",
    viewerUserId: "viewer",
    isChildChannel: false,
    anchorMessageId: null,
    preferCachedWindowOnMount,
  })
  return createElement("output", {
    "data-divider": result.newDividerBefore,
    "data-unread": result.unreadCount,
  })
}

function CaptureDefaultMount() {
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
    mocks.useMessages.mockReset()
    mocks.watermark.mockReset()
  })

  it("revalidates a normal mount and preserves the cached window on a restored mount", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(CaptureDefaultMount))
    })
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      reconcileLateAnchor: true,
      revalidateOnMount: true,
    }))
    expect(renderer!.root.findByType("output").props).toMatchObject({
      "data-divider": "peer",
      "data-unread": 3,
    })

    act(() => {
      renderer!.update(createElement(Capture, { preferCachedWindowOnMount: true }))
    })
    expect(mocks.useMessages).toHaveBeenLastCalledWith("channel", expect.objectContaining({
      reconcileLateAnchor: false,
      revalidateOnMount: false,
    }))
    act(() => renderer!.unmount())
  })
})
