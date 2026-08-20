import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderMessageListRow } from "./message-list-row"
import { MessageRow } from "../message-row"
import type { FlatItem } from "@/lib/community/message-list-items"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"
import "./message-row-menu-parity.test"
import "./message-row-view.test"

vi.mock("../message-row", () => ({ MessageRow: vi.fn(() => null) }))
vi.mock("@/components/community/dividers", () => ({
  DateDivider: ({ label }: { label: string }) => React.createElement("date-divider", { label }),
  NewDivider: ({ dateLabel }: { dateLabel?: string }) => React.createElement("new-divider", { dateLabel }),
}))

const mockedMessageRow = vi.mocked(MessageRow)

const callbacks = {
  onOpenThread: vi.fn(),
  onOpenProfile: vi.fn(),
  onToggleReaction: vi.fn(),
  onReact: vi.fn(),
  onReply: vi.fn(),
  onPin: vi.fn(),
  onMark: vi.fn(),
  onCreateThread: vi.fn(),
  onCopy: vi.fn(),
  onEdit: vi.fn(),
  onRetry: vi.fn(),
  onDismiss: vi.fn(),
  onPreviewImage: vi.fn(),
  onPreviewAttachment: vi.fn(),
  onDownloadFile: vi.fn(),
  resolveUserName: vi.fn(),
}

const props = {
  channel: "general",
  messages: [],
  variant: "channel" as const,
  initialScrollReady: true,
  viewerUserId: "viewer_1",
  pinnedIds: new Set(["m1"]),
  ...callbacks,
} satisfies ResolvedMessageListProps

const controller = {
  jumped: "m1",
  selectMode: true,
  selectedIds: new Set(["m1"]),
  jumpTo: vi.fn(),
  onImageLoad: vi.fn(),
  onToggleSelectId: vi.fn(),
  onEnterSelectId: vi.fn(),
} as unknown as MessageListController

describe("renderMessageListRow", () => {
  beforeEach(() => vi.clearAllMocks())

  it("renders divider branches without mounting MessageRow", () => {
    let date: TestRenderer.ReactTestRenderer
    let unread: TestRenderer.ReactTestRenderer
    act(() => {
      date = TestRenderer.create(renderMessageListRow(
        { kind: "date-divider", key: "d", label: "Today" } as FlatItem,
        props,
        controller,
      ))
      unread = TestRenderer.create(renderMessageListRow(
        { kind: "new-divider", key: "n", dateLabel: "Today" } as FlatItem,
        props,
        controller,
      ))
    })
    expect(date!.root.findByType("date-divider").props.label).toBe("Today")
    expect(unread!.root.findByType("new-divider").props.dateLabel).toBe("Today")
    expect(mockedMessageRow).not.toHaveBeenCalled()
  })

  it("projects every row identity/action prop and gates edit to the viewer", () => {
    const message = {
      id: "m1",
      type: "chat" as const,
      authorId: "viewer_1",
      authorName: "Viewer",
      content: "hello",
      createdAt: new Date(0).toISOString(),
      grouped: false,
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderMessageListRow(
        { kind: "message", key: "m1", m: message } as FlatItem,
        props,
        controller,
      ))
    })
    const wrapper = renderer!.root.findByProps({ "data-msg-id": "m1" })
    expect(wrapper.props["data-testid"]).toBe("community-message-m1")
    expect(mockedMessageRow).toHaveBeenCalledWith(expect.objectContaining({
      m: message,
      viewerUserId: "viewer_1",
      pinned: true,
      highlighted: true,
      onOpenThread: callbacks.onOpenThread,
      onOpenProfile: callbacks.onOpenProfile,
      onToggleReactionId: callbacks.onToggleReaction,
      onReactId: callbacks.onReact,
      onReplyId: callbacks.onReply,
      onPinId: callbacks.onPin,
      onMarkId: callbacks.onMark,
      onCreateThreadId: callbacks.onCreateThread,
      onCopyId: callbacks.onCopy,
      onEditId: callbacks.onEdit,
      onRetryId: callbacks.onRetry,
      onDismissId: callbacks.onDismiss,
      onJumpToId: controller.jumpTo,
      onPreviewImage: callbacks.onPreviewImage,
      onPreviewAttachment: callbacks.onPreviewAttachment,
      onDownloadFile: callbacks.onDownloadFile,
      resolveUserName: callbacks.resolveUserName,
      onImageLoad: controller.onImageLoad,
      selectMode: true,
      selected: true,
      onToggleSelectId: controller.onToggleSelectId,
      onEnterSelectId: controller.onEnterSelectId,
    }), undefined)

    act(() => {
      renderer!.update(renderMessageListRow(
        { kind: "message", key: "m1", m: { ...message, authorId: "peer_1" } } as FlatItem,
        props,
        controller,
      ))
    })
    expect(mockedMessageRow.mock.calls.at(-1)?.[0].onEditId).toBeUndefined()
  })
})
