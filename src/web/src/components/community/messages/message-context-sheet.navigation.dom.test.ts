import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  close: vi.fn(),
  openThread: undefined as undefined | ((threadId: string) => void),
  pin: undefined as undefined | ((messageId: string) => void),
  pinMutate: vi.fn(),
  unpinMutate: vi.fn(),
  toastApiError: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useParams: () => ({ serverId: "server_1" }),
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      notFound: false,
      anchorId: "message_1",
      messages: [{
        id: "message_1",
        seq: 1,
        type: "chat",
        authorId: "author_1",
        authorName: "Author",
        content: "Message",
        createdAt: "2026-08-20T00:00:00.000Z",
        thread: { id: "child_1", name: "Child", messageCount: 1 },
      }],
    },
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}))
vi.mock("@/components/community/shell/community-sheet", () => ({
  CommunitySheet: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/ui/sheet-resize-handle", () => ({
  useSheetResize: () => ({
    width: 420,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  }),
  SheetResizeHandle: () => null,
}))
vi.mock("./message-row", () => ({
  MessageRow: ({
    onOpenThread,
    onPinId,
  }: {
    onOpenThread: (threadId: string) => void
    onPinId?: (messageId: string) => void
  }) => {
    mocks.openThread = onOpenThread
    mocks.pin = onPinId
    return null
  },
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: () => null }))
vi.mock("../channels/channel-icon", () => ({ ChannelIcon: () => null }))
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }))
vi.mock("../dividers", () => ({ DateDivider: () => null }))
vi.mock("@/contexts/community/current-user", () => ({
  useCurrentUser: () => ({ id: "viewer_1" }),
}))
vi.mock("@/stores/community", () => ({ useUiHandlers: () => ({}) }))
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))
vi.mock("@/hooks/community/mutations", () => ({
  usePinMessage: () => ({ mutate: mocks.pinMutate }),
  useUnpinMessage: () => ({ mutate: mocks.unpinMutate }),
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
  useToggleMark: () => vi.fn(),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: mocks.toastApiError }))

import {
  MessageContextSheet,
  openMessageContextThread,
} from "./message-context-sheet"

describe("MessageContextSheet thread navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openThread = undefined
    mocks.pin = undefined
  })

  it("opens a rendered channel thread by its flat child id and closes the sheet", () => {
    render(React.createElement(MessageContextSheet, {
      open: false,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
    }))
    act(() => mocks.openThread?.("child_1"))

    expect(mocks.push).toHaveBeenCalledWith("/c/channels/server_1/child_1")
    expect(mocks.close).toHaveBeenCalledWith(false)
  })

  it("does not navigate from a DM or without a server route", () => {
    const push = vi.fn()
    const close = vi.fn()

    expect(openMessageContextThread({
      type: "dm",
      serverId: "server_1",
      threadId: "child_1",
      push,
      close,
    })).toBe(false)
    expect(openMessageContextThread({
      type: "channel",
      threadId: "child_1",
      push,
      close,
    })).toBe(false)
    expect(push).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it("exposes preview Pin only to managers and opens pinned only after success", () => {
    const onOpenPinned = vi.fn()
    const member = render(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
      canManagePins: false,
      onOpenPinned,
    }))
    expect(mocks.pin).toBeUndefined()

    member.rerender(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
      canManagePins: true,
      onOpenPinned,
    }))
    expect(mocks.pin).toEqual(expect.any(Function))

    act(() => mocks.pin?.("message_1"))
    expect(mocks.pinMutate).toHaveBeenCalledWith(
      { channelId: "parent_1", messageId: "message_1" },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    )
    expect(mocks.close).not.toHaveBeenCalled()
    expect(onOpenPinned).not.toHaveBeenCalled()

    const options = mocks.pinMutate.mock.calls.at(-1)?.[1]
    const error = new Error("role changed")
    act(() => options.onError(error))
    expect(mocks.toastApiError).toHaveBeenCalledWith(error, "Failed to pin message")
    expect(mocks.close).not.toHaveBeenCalled()
    expect(onOpenPinned).not.toHaveBeenCalled()

    act(() => options.onSuccess())
    expect(mocks.close).toHaveBeenCalledWith(false)
    expect(onOpenPinned).toHaveBeenCalledOnce()
  })

  it("never opens pinned automatically after preview Unpin", () => {
    const onOpenPinned = vi.fn()
    render(React.createElement(MessageContextSheet, {
      open: true,
      onOpenChange: mocks.close,
      channelId: "parent_1",
      targetSeq: 1,
      pinnedIds: new Set(["message_1"]),
      canManagePins: true,
      onOpenPinned,
    }))

    act(() => mocks.pin?.("message_1"))
    const options = mocks.unpinMutate.mock.calls.at(-1)?.[1]
    act(() => options.onSuccess())
    expect(mocks.close).not.toHaveBeenCalled()
    expect(onOpenPinned).not.toHaveBeenCalled()
  })
})
