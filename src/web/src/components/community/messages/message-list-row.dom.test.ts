import React from "react"
import { compile, optimize } from "@tailwindcss/node"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { renderMessageListRow } from "./message-list-row"
import { MessageRow } from "./message-row"
import type { FlatItem } from "@/lib/community/message-list-items"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

vi.mock("./message-row", () => ({ MessageRow: vi.fn(() => null) }))

const mockedMessageRow = vi.mocked(MessageRow)

async function withTailwindStyles(container: HTMLElement, check: () => void) {
  const css = await compile("@theme inline { --spacing: 4px; } @tailwind utilities;", {
    base: process.cwd(),
    onDependency: () => {},
  })
  const style = document.createElement("style")
  style.textContent = optimize(css.build(Array.from(container.querySelectorAll("[class]")).flatMap((element) => Array.from(element.classList))), { minify: true }).code
  document.head.append(style)
  try {
    check()
  } finally {
    style.remove()
  }
}

function marginPx(element: Element, side: "Top" | "Bottom") {
  const style = getComputedStyle(element)
  const physical = style[`margin${side}`]
  // JSDOM leaves an unmapped logical margin's physical default as "0"; explicit physical zero is "0px".
  return parseFloat(physical === "0" ? style.marginBlock || "0" : physical)
}

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
  items: [null],
  topSentinelRef: vi.fn(),
  bottomSentinelRef: vi.fn(),
  onToggleSelectId: vi.fn(),
  onEnterSelectId: vi.fn(),
} as unknown as MessageListController

describe("renderMessageListRow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedMessageRow.mockImplementation(() => null)
  })

  it("keeps merged New/date and edge decorations outside the actual body", () => {
    const items: FlatItem[] = [
      { kind: "leading", key: "leading" },
      { kind: "divider", key: "new:m1", messageId: "m1", dateLabel: "Today", newDivider: true },
      { kind: "message", key: "m1", m: { id: "m1", type: "chat" } },
      { kind: "trailing", key: "trailing" },
    ]
    const view = render(React.createElement(React.Fragment, null, items.map((item, index) =>
      React.createElement(React.Fragment, { key: item.key }, renderMessageListRow(item, { ...props, hasMore: true, hasMoreNewer: true }, { ...controller, items }, index)),
    )))
    const body = view.container.querySelector('[data-msg-id="m1"]')!
    expect(view.container.querySelector("[data-new-divider]")).toHaveTextContent("Today")
    expect(body.querySelector("[data-new-divider]")).toBeNull()
    expect(view.getAllByText("Today")).toHaveLength(1)
    expect(view.container.firstElementChild).toHaveClass("flow-root")
    expect(view.container.querySelectorAll('[data-msg-id]')).toHaveLength(1)
    expect(view.container.querySelector('[data-message-divider-for="m1"]')).toBeInTheDocument()
    expect(controller.topSentinelRef).toHaveBeenCalled()
    expect(controller.bottomSentinelRef).toHaveBeenCalled()
    expect(mockedMessageRow).toHaveBeenCalledOnce()
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
      0,
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
      selectMode: true,
      selected: true,
      onToggleSelectId: controller.onToggleSelectId,
      onEnterSelectId: controller.onEnterSelectId,
    }), undefined)

    renderer.rerender(renderMessageListRow(
      { kind: "message", key: "m1", m: { ...message, authorId: "peer_1" } } as FlatItem,
      props,
      controller,
      0,
    ))
    expect(mockedMessageRow.mock.calls.at(-1)?.[0].onEditId).toBeUndefined()
    expect(mockedMessageRow.mock.calls.at(-1)?.[0].onImageLoad).toBeUndefined()
  })

  it.each([
    { name: "date to ungrouped chat", dateLabel: "Today", newDivider: false, grouped: false, type: "chat", gap: 12 },
    { name: "NEW to ungrouped chat", dateLabel: undefined, newDivider: true, grouped: false, type: "chat", gap: 12 },
    { name: "merged date/NEW to ungrouped chat", dateLabel: "Today", newDivider: true, grouped: false, type: "chat", gap: 12 },
    { name: "date to pending-window grouped chat", dateLabel: "Today", newDivider: false, grouped: true, type: "chat", gap: 8 },
    { name: "NEW to grouped chat", dateLabel: undefined, newDivider: true, grouped: true, type: "chat", gap: 4 },
    { name: "date to system", dateLabel: "Today", newDivider: false, grouped: false, type: "system", gap: 8 },
    { name: "NEW to system", dateLabel: undefined, newDivider: true, grouped: false, type: "system", gap: 4 },
  ] as const)("keeps original independent-row margins: $name", async ({ dateLabel, newDivider, grouped, type, gap }) => {
    mockedMessageRow.mockImplementation(({ m }) => React.createElement("div", {
      className: m.type === "chat" && !m.grouped ? "mt-3" : undefined,
    }))
    const items: FlatItem[] = [
      { kind: "leading", key: "leading" },
      { kind: "message", key: "previous", m: { id: "previous", type: "chat", grouped: false } },
      { kind: "divider", key: "divider", messageId: "m1", dateLabel, newDivider },
      { kind: "message", key: "m1", m: { id: "m1", type, grouped } },
    ]
    const view = render(React.createElement(React.Fragment, null, items.map((item, index) =>
      React.createElement(React.Fragment, { key: item.key }, renderMessageListRow(item, props, { ...controller, items }, index)),
    )))
    await withTailwindStyles(view.container, () => {
      const divider = view.container.querySelector('[data-message-divider-for="m1"] > div')!
      const message = view.container.querySelector('[data-msg-id="m1"] > div')!
      expect(marginPx(divider, "Bottom") + marginPx(message, "Top")).toBe(gap)
    })
  })

  it.each(["date", "NEW", "merged date/NEW", "message"])("keeps the leading boundary margin before %s", async (next) => {
    mockedMessageRow.mockImplementation(() => React.createElement("div", { className: "mt-3" }))
    const items: FlatItem[] = [
      { kind: "leading", key: "leading" },
      ...(next === "message" ? [] : [{ kind: "divider" as const, key: "divider", messageId: "m1", dateLabel: next === "NEW" ? undefined : "Today", newDivider: next !== "date" }]),
      { kind: "message", key: "m1", m: { id: "m1", type: "chat", grouped: false } },
    ]
    const view = render(React.createElement(React.Fragment, null, items.map((item, index) =>
      React.createElement(React.Fragment, { key: item.key }, renderMessageListRow(item, { ...props, hasMore: true }, { ...controller, items }, index)),
    )))
    await withTailwindStyles(view.container, () => {
      const leading = view.container.querySelector('[data-message-row-key="leading"] > div')!
      const following = view.container.querySelector(next === "message" ? '[data-msg-id="m1"] > div' : '[data-message-divider-for="m1"] > div')!
      expect(marginPx(leading, "Bottom") + marginPx(following, "Top")).toBe(24)
    })
  })
})
