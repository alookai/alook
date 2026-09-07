import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { renderMessageListRow } from "./message-list-row"
import { MessageRow } from "./message-row"
import type { FlatItem } from "@/lib/community/message-list-items"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

vi.mock("./message-row", () => ({ MessageRow: vi.fn(() => null) }))
vi.mock("../dividers", () => ({
  DateDivider: ({ label }: { label: string }) => React.createElement("div", {
    "data-testid": "date-divider",
    "data-label": label,
  }),
  NewDivider: ({ dateLabel }: { dateLabel?: string }) => React.createElement("div", {
    "data-testid": "new-divider",
    "data-date-label": dateLabel,
  }),
}))

const mockedMessageRow = vi.mocked(MessageRow)

const callbacks = {
  onOpenThread: vi.fn(),
  onOpenProfile: vi.fn(),
  onToggleReaction: vi.fn(),
  onReact: vi.fn(),
  onReply: vi.fn(),
  resolveAuthorMentionText: vi.fn(() => "@Viewer#1234 "),
  onInsertMentionText: vi.fn(),
  onPin: vi.fn(),
  onMark: vi.fn(),
  onCreateThread: vi.fn(),
  onCopy: vi.fn(),
  onEdit: vi.fn(),
  onRetry: vi.fn(),
  onDismiss: vi.fn(),
  onPreviewImage: vi.fn(),
  onPreviewAttachment: vi.fn(),
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
    const date = render(renderMessageListRow(
      { kind: "date-divider", key: "d", label: "Today" } as FlatItem,
      props,
      controller,
    ))
    const unread = render(renderMessageListRow(
      { kind: "new-divider", key: "n", dateLabel: "Today" } as FlatItem,
      props,
      controller,
    ))
    expect(date.getByTestId("date-divider")).toHaveAttribute("data-label", "Today")
    expect(unread.getByTestId("new-divider")).toHaveAttribute("data-date-label", "Today")
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
    const renderer = render(renderMessageListRow(
      { kind: "message", key: "m1", m: message } as FlatItem,
      props,
      controller,
    ))
    expect(renderer.container.querySelector('[data-msg-id="m1"]'))
      .toHaveAttribute("data-testid", "community-message-m1")
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
      mentionText: "@Viewer#1234 ",
      onInsertMentionText: callbacks.onInsertMentionText,
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
      resolveUserName: callbacks.resolveUserName,
      onImageLoad: controller.onImageLoad,
      selectMode: true,
      selected: true,
      onToggleSelectId: controller.onToggleSelectId,
      onEnterSelectId: controller.onEnterSelectId,
    }), undefined)

    renderer.rerender(renderMessageListRow(
      { kind: "message", key: "m1", m: { ...message, authorId: "peer_1" } } as FlatItem,
      props,
      controller,
    ))
    expect(mockedMessageRow.mock.calls.at(-1)?.[0].onEditId).toBeUndefined()
  })
})
