import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageChannelController } from "../messages/message-channel-controller"
import type { MessageChannelControllerValue } from "../messages/message-channel-controller"
import { ChannelHeader } from "./channel-header"
import { TextChannelSurface } from "./text-channel-surface"
import { useChannelMessageFeed } from "@/hooks/community/use-channel-message-feed"
import { buildAttachmentUploadFormData } from "@/hooks/community/mutations/uploads"
import { useMessageStreamStore } from "@/stores/community/message-stream"

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
  usePathname: () => "/c/channels/server_1/channel_1",
  useSearchParams: () => ({ get: () => null }),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))
vi.mock("@/hooks/use-mobile", () => ({ useBreakpoint: () => "desktop" }))
vi.mock("@/hooks/community/use-channel-message-feed", () => ({
  useChannelMessageFeed: vi.fn(),
}))
vi.mock("@/components/community/channels/channel-header", () => ({
  ChannelHeader: vi.fn(() => null),
}))
vi.mock("@/components/community/channels/channel-shell", () => ({
  ChannelShell: ({ header, body }: { header: React.ReactNode; body: React.ReactNode }) =>
    React.createElement(React.Fragment, null, header, body),
}))
vi.mock("@/components/community/messages/composer", () => ({
  Composer: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/message-list", () => ({
  MessageList: vi.fn(() => null),
}))
vi.mock("@/components/community/shell/community-panel", () => ({
  CommunityPanel: vi.fn(() => null),
}))
vi.mock("@/components/community/messages/message-context-sheet", () => ({
  MessageContextSheet: vi.fn(() => null),
}))
vi.mock("@alook/shared", () => ({
  deriveThreadName: () => "thread",
  MAX_ATTACHMENT_THUMBNAIL_SIZE_BYTES: 50 * 1024,
}))
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
  tempMessageId: () => "temp_1",
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

const mockedChannelHeader = vi.mocked(ChannelHeader)
const mockedUseChannelMessageFeed = vi.mocked(useChannelMessageFeed)

function renderController(
  messageFeed: ReturnType<typeof useChannelMessageFeed>,
  targetId = "m_target",
  callbacks: {
    onOpenThread?: (threadId: string) => void
    onOpenPinned?: () => void
    passivePinVersion?: number
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
    (controller) => React.createElement(PassiveActionProbe, {
      controller,
      pinVersion: callbacks.passivePinVersion ?? 0,
    }),
  )
}

function PassiveActionProbe({
  controller,
  pinVersion,
}: {
  controller: MessageChannelControllerValue
  pinVersion: number
}) {
  React.useEffect(() => {
    if (pinVersion > 0) controller.messageActions.onPin("m_target")
  }, [controller.messageActions, pinVersion])
  return React.createElement(ControllerProbe, { controller })
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
    useMessageStreamStore.getState().resetAll()
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

  it("updates latest action callbacks before descendant passive effects run", () => {
    const firstOpenPinned = vi.fn()
    const latestOpenPinned = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(
        feed({ messages: [{ id: "m_target" }] }),
        "m_target",
        { onOpenPinned: firstOpenPinned },
      ))
    })
    act(() => {
      renderer!.update(renderController(
        feed({ messages: [{ id: "m_target" }] }),
        "m_target",
        { onOpenPinned: latestOpenPinned, passivePinVersion: 1 },
      ))
    })

    expect(latestOpenPinned).toHaveBeenCalledTimes(1)
    expect(firstOpenPinned).not.toHaveBeenCalled()
  })

  it("retries a failed channel upload with the identical thumbnail Blob in multipart", async () => {
    const thumbnailBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })
    const file = new File(["original"], "photo.png", { type: "image/png" })
    mutationMocks.uploadFile
      .mockRejectedValueOnce(new Error("upload failed"))
      .mockResolvedValueOnce({
        id: "att_thumb",
        filename: "photo.png",
        contentType: "image/png",
        size: 8,
        hasThumbnail: true,
      })
    mutationMocks.sendMessage.mockResolvedValueOnce({ message: { id: "server_thumb", seq: 10 } })
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(renderController(feed()))
    })
    const firstController = renderer!.root.findByType(ControllerProbe).props.controller as MessageChannelControllerValue
    await act(async () => {
      firstController.acceptMessage("photo", [{
        file,
        thumbnailBlob,
        previewObjectUrl: "blob:thumbnail",
        width: 640,
        height: 480,
      }])
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      renderer!.update(renderController(feed({
        messages: [{ id: "temp_1", clientNonce: "nonce_1", type: "chat", content: "photo" }],
      })))
    })
    const retriedController = renderer!.root.findByType(ControllerProbe).props.controller as MessageChannelControllerValue
    await act(async () => {
      retriedController.messageActions.onRetry("temp_1")
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mutationMocks.uploadFile).toHaveBeenCalledTimes(2)
    for (const [args] of mutationMocks.uploadFile.mock.calls) {
      expect(args.thumbnailBlob).toBe(thumbnailBlob)
      expect((buildAttachmentUploadFormData(args).get("thumbnail") as File).size).toBe(4)
    }
  })
})

describe("TextChannelSurface header hierarchy", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("forwards the direct mobile server segment without a Back fallback", () => {
    const headerServer = {
      id: "server_1",
      name: "Server",
      icon: null,
      onNavigate: vi.fn(),
    }
    mockedUseChannelMessageFeed.mockReturnValue(feed())

    act(() => {
      TestRenderer.create(React.createElement(TextChannelSurface, {
        channelId: "channel_1",
        serverId: "server_1",
        serverParam: "server_1",
        channelName: "general",
        viewer: { id: "viewer_1", name: "Viewer", avatar: "V" },
        anchorMessageId: null,
        headerServer,
        notificationLevel: "default",
        onSetNotificationLevel: vi.fn(),
        composerMembers: [],
        composerMentionCandidates: undefined,
        channelRefCandidates: [],
        memberPanelProps: { members: [] },
        manageMembersDialog: null,
        uiHandlers: {},
        onOpenThread: vi.fn(),
        onOpenProfile: vi.fn(),
        resolveUserName: (userId: string) => userId,
      }))
    })

    const headerProps = mockedChannelHeader.mock.calls.at(-1)![0]
    expect(headerProps.mobileServer).toBe(headerServer)
    expect(headerProps).not.toHaveProperty("onBack")
  })
})
