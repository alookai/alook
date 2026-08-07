import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageChannelController } from "./message-channel-controller"
import type { MessageChannelControllerValue } from "./message-channel-controller"
import type { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"

const mutationMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  toggleReaction: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  toggleMark: vi.fn(),
  editMessage: vi.fn(),
  createThread: vi.fn(async () => ({ id: "thread_1" })),
  uploadFile: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@alook/shared", () => ({ deriveThreadName: () => "thread" }))
vi.mock("@/stores/community", () => {
  const state = {
    pendingReply: null,
    setPendingReply: vi.fn(),
    registerUiHandlers: vi.fn(),
  }
  const useCommunityStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return {
    useCommunityStore,
    useTypingUsersForScope: () => [],
    useTypingNamesForScope: () => ({}),
  }
})
vi.mock("@/hooks/community/mutations", () => ({
  useSendMessage: () => ({ mutateAsync: mutationMocks.sendMessage }),
  useToggleReactionApi: () => mutationMocks.toggleReaction,
  usePinMessage: () => ({ mutate: mutationMocks.pinMessage }),
  useUnpinMessage: () => ({ mutate: mutationMocks.unpinMessage }),
  useToggleMark: () => mutationMocks.toggleMark,
  useEditMessage: () => ({ mutate: mutationMocks.editMessage }),
  useCreateThread: () => ({ mutateAsync: mutationMocks.createThread }),
  useUploadFile: () => ({ mutateAsync: mutationMocks.uploadFile }),
  zipUploadResultsWithDimensions: () => [],
  sendNonce: () => "nonce_1",
}))
vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsSendTyping: vi.fn(),
  communityWsResetTypingThrottle: vi.fn(),
}))

function feed(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    isLoading: false,
    isError: false,
    isFetchingOlder: false,
    isFetchingNewer: false,
    pinned: [],
    ...overrides,
  } as ReturnType<typeof useChannelMessageFeed>
}

function renderController(
  messageFeed: ReturnType<typeof useChannelMessageFeed>,
  targetId = "m_target",
  callbacks: {
    onOpenThread?: (threadId: string) => void
    onOpenPinned?: () => void
  } = {},
) {
  return React.createElement(
    MessageChannelController,
    {
      channelId: "channel_1",
      serverId: "server_1",
      serverParam: "server_1",
      channelName: "general",
      viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
      anchorMessageId: targetId,
      feed: messageFeed,
      uiHandlers: {},
      onOpenThread: callbacks.onOpenThread ?? vi.fn(),
      onOpenPinned: callbacks.onOpenPinned ?? vi.fn(),
      resolveUserName: (userId: string) => userId,
    },
    (controller) => React.createElement(ControllerProbe, { controller }),
  )
}

function ControllerProbe({ controller }: { controller: MessageChannelControllerValue }) {
  return React.createElement("div", {
    "data-scroll-target": controller.scrollTargetId,
    onClick: () => controller.consumeScrollTarget("m_target"),
  })
}

describe("MessageChannelController scroll target ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("passes the route anchor through while the feed is loading", () => {
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(feed({ isLoading: true })))
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
  })

  it("keeps a loaded target until MessageList reports consumption", () => {
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(feed({ messages: [{ id: "m_target" }] })))
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    act(() => vi.advanceTimersByTime(5000))
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    act(() => renderer!.root.findByType("div").props.onClick())
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBeNull()
  })

  it("keeps a missing target across warm cache until the anchor request errors", () => {
    let messageFeed = feed({ messages: [{ id: "m_unrelated" }] })
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(messageFeed))
    })

    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBe("m_target")
    messageFeed = feed({ messages: [{ id: "m_unrelated" }], isError: true })
    act(() => renderer!.update(renderController(messageFeed)))
    expect(renderer!.root.findByType("div").props["data-scroll-target"]).toBeNull()
  })

  it("does not start a visual highlight timer for a loaded target", () => {
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(feed({ messages: [{ id: "m_target" }] })))
    })
    expect(vi.getTimerCount()).toBe(0)
    act(() => renderer!.unmount())
  })

  it("keeps message action references stable while calling the latest surface callbacks", async () => {
    const firstOpenThread = vi.fn()
    const firstOpenPinned = vi.fn()
    const latestOpenThread = vi.fn()
    const latestOpenPinned = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(
        feed({ messages: [{ id: "m_target", content: "first" }] }),
        "m_target",
        { onOpenThread: firstOpenThread, onOpenPinned: firstOpenPinned },
      ))
    })
    const firstActions = renderer!.root.findByType(ControllerProbe).props.controller.messageActions

    act(() => {
      renderer!.update(renderController(
        feed({ messages: [{ id: "m_target", content: "latest" }] }),
        "m_target",
        { onOpenThread: latestOpenThread, onOpenPinned: latestOpenPinned },
      ))
    })
    const latestActions = renderer!.root.findByType(ControllerProbe).props.controller.messageActions

    expect(latestActions).toBe(firstActions)
    act(() => latestActions.onPin("m_target"))
    expect(latestOpenPinned).toHaveBeenCalledTimes(1)
    expect(firstOpenPinned).not.toHaveBeenCalled()
    await act(async () => {
      await latestActions.onCreateThread("m_target")
    })
    expect(latestOpenThread).toHaveBeenCalledWith("thread_1")
    expect(firstOpenThread).not.toHaveBeenCalled()
  })
})
