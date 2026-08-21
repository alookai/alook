import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  close: vi.fn(),
  openThread: undefined as undefined | ((threadId: string) => void),
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
  MessageRow: ({ onOpenThread }: { onOpenThread: (threadId: string) => void }) => {
    mocks.openThread = onOpenThread
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
  usePinMessage: () => ({ mutate: vi.fn() }),
  useUnpinMessage: () => ({ mutate: vi.fn() }),
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
  useToggleMark: () => vi.fn(),
}))
vi.mock("sonner", () => ({ toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn(), toastApiError: vi.fn() }))

import {
  MessageContextSheet,
  openMessageContextThread,
} from "./message-context-sheet"

describe("MessageContextSheet thread navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openThread = undefined
  })

  it("opens a rendered channel thread by its flat child id and closes the sheet", () => {
    act(() => {
      TestRenderer.create(React.createElement(MessageContextSheet, {
        open: false,
        onOpenChange: mocks.close,
        channelId: "parent_1",
        targetSeq: 1,
      }))
    })
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
})
