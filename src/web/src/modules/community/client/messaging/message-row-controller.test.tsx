import { createRequire } from "node:module"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageRow, type MessageRowProps } from "./message-row"

const mocks = vi.hoisted(() => ({
  marked: { data: undefined as { marked: boolean } | undefined, isLoading: false },
  useMessageMarked: vi.fn(),
  viewProps: null as Record<string, any> | null,
  selectionBelongsToRow: vi.fn((_selection?: unknown, _row?: unknown) => false),
}))

vi.mock("@/hooks/community/use-inbox", () => ({
  useMessageMarked: (messageId: string, enabled: boolean) => {
    mocks.useMessageMarked(messageId, enabled)
    return mocks.marked
  },
}))

vi.mock("./internal/message-row-view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./internal/message-row-view")>()
  return {
    ...actual,
    createMessageMenuPointAnchor: (clientX: number, clientY: number) => ({
      getBoundingClientRect: () => ({ x: clientX, y: clientY, width: 0, height: 0 }),
    }),
    selectionBelongsToRow: (selection: unknown, row: unknown) => mocks.selectionBelongsToRow(selection, row),
    MessageRowView: (props: Record<string, any>) => {
      mocks.viewProps = props
      return React.createElement("message-row-view")
    },
  }
})

type Renderer = { unmount: () => void }
const rendererModule = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void) => void
  create: (element: React.ReactElement) => Renderer
}
const { act } = rendererModule

const message = {
  id: "m1",
  type: "chat" as const,
  authorId: "u1",
  authorName: "Alice",
  content: "hello",
  createdAt: new Date(0).toISOString(),
  grouped: false,
  replyTo: { id: "parent", authorName: "Bob", text: "before" },
}

function props(overrides: Partial<MessageRowProps> = {}): MessageRowProps {
  return {
    m: message,
    hoverCapable: true,
    onOpenThread: vi.fn(),
    ...overrides,
  }
}

function render(value: MessageRowProps) {
  let renderer: Renderer
  act(() => {
    renderer = rendererModule.create(React.createElement(MessageRow, value))
  })
  return renderer!
}

function latestProps() {
  expect(mocks.viewProps).not.toBeNull()
  return mocks.viewProps!
}

describe("MessageRow controller", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
    mocks.marked = { data: undefined, isLoading: false }
    mocks.viewProps = null
    mocks.selectionBelongsToRow.mockReset().mockReturnValue(false)
    mocks.useMessageMarked.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("enables the marked query only while an actionable menu is open", () => {
    mocks.marked = { data: { marked: true }, isLoading: true }
    const renderer = render(props({ onMarkId: vi.fn() }))
    expect(mocks.useMessageMarked).toHaveBeenLastCalledWith("m1", false)
    expect(latestProps()).toMatchObject({ marked: true, markedLoading: true })

    act(() => latestProps().onToolbarOpenChange(true))
    expect(mocks.useMessageMarked).toHaveBeenLastCalledWith("m1", true)
    act(() => latestProps().onToolbarOpenChange(false))
    act(() => latestProps().onContextOpenChange(true))
    expect(mocks.useMessageMarked).toHaveBeenLastCalledWith("m1", true)
    act(() => latestProps().onContextOpenChange(false))
    act(() => latestProps().onTouchMenuOpenChange(true))
    expect(mocks.useMessageMarked).toHaveBeenLastCalledWith("m1", true)
    renderer.unmount()

    const withoutMark = render(props())
    act(() => latestProps().onToolbarOpenChange(true))
    expect(mocks.useMessageMarked).toHaveBeenLastCalledWith("m1", false)
    withoutMark.unmount()
  })

  it("binds every row action to the current message identity", () => {
    const onToggleReactionId = vi.fn()
    const onReactId = vi.fn()
    const onReplyId = vi.fn()
    const onPinId = vi.fn()
    const onMarkId = vi.fn()
    const onCreateThreadId = vi.fn()
    const onCopyId = vi.fn()
    const onEditId = vi.fn()
    const onRetryId = vi.fn()
    const onDismissId = vi.fn()
    const onJumpToId = vi.fn()
    const onToggleSelectId = vi.fn()
    const onEnterSelectId = vi.fn()
    const onShareSingleId = vi.fn()
    const renderer = render(props({
      onToggleReactionId, onReactId, onReplyId, onPinId, onMarkId,
      onCreateThreadId, onCopyId, onEditId, onRetryId, onDismissId,
      onJumpToId, onToggleSelectId, onEnterSelectId, onShareSingleId,
    }))
    const view = latestProps()
    view.onToggleReaction("🔥")
    view.onReact("👍")
    view.onReply()
    view.onPin()
    view.onMark()
    view.onCreateThread()
    view.onCopy()
    view.onEdit()
    view.onRetry()
    view.onDismiss()
    view.onJumpReply()
    view.onToggleSelect()
    view.onEnterSelect()
    view.onShareSingle()
    expect(onToggleReactionId).toHaveBeenCalledWith("m1", "🔥")
    expect(onReactId).toHaveBeenCalledWith("m1", "👍")
    for (const callback of [
      onReplyId, onPinId, onMarkId, onCreateThreadId, onCopyId, onEditId,
      onRetryId, onDismissId, onToggleSelectId, onEnterSelectId, onShareSingleId,
    ]) expect(callback).toHaveBeenCalledWith("m1")
    expect(onJumpToId).toHaveBeenCalledWith("parent")
    renderer.unmount()
  })

  it("keeps absent capabilities undefined and skips a missing reply target", () => {
    const onJumpToId = vi.fn()
    const renderer = render(props({
      m: { ...message, replyTo: undefined },
      onJumpToId,
    }))
    const view = latestProps()
    expect(view).toMatchObject({
      onToggleReaction: undefined,
      onReact: undefined,
      onReply: undefined,
      onPin: undefined,
      onMark: undefined,
      onCreateThread: undefined,
      onCopy: undefined,
      onEdit: undefined,
      onRetry: undefined,
      onDismiss: undefined,
      onJumpReply: undefined,
      onToggleSelect: undefined,
      onEnterSelect: undefined,
      onShareSingle: undefined,
    })
    expect(onJumpToId).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("owns activation and touch gesture state before projecting it to the View", () => {
    const now = vi.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(400)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_600)
    vi.stubGlobal("performance", { now })
    vi.stubGlobal("window", { getSelection: () => null })
    const renderer = render(props({ hoverCapable: false, onCopyId: vi.fn() }))

    act(() => latestProps().onActivate())
    expect(latestProps().activated).toBe(true)
    act(() => latestProps().onTouchStart())
    act(() => latestProps().onTouchEnd())
    act(() => latestProps().onTouchBodyClick({
      clientX: 23,
      clientY: 42,
      currentTarget: { contains: () => false },
      target: { closest: () => null },
    }))
    expect(latestProps().touchMenuOpen).toBe(true)
    expect(latestProps().touchMenuAnchor.getBoundingClientRect()).toMatchObject({ x: 23, y: 42 })

    act(() => latestProps().onTouchMenuOpenChange(false))
    act(() => latestProps().onTouchStart())
    act(() => latestProps().onTouchEnd())
    act(() => latestProps().onTouchBodyClick({
      clientX: 1,
      clientY: 2,
      currentTarget: { contains: () => false },
      target: { closest: () => null },
    }))
    expect(latestProps().touchMenuOpen).toBe(false)

    act(() => latestProps().onTouchCancel())
    act(() => latestProps().onTouchBodyClick({
      clientX: 3,
      clientY: 4,
      currentTarget: { contains: () => false },
      target: { closest: () => ({}) },
    }))
    expect(latestProps().touchMenuOpen).toBe(false)

    mocks.selectionBelongsToRow.mockReturnValue(true)
    act(() => latestProps().onTouchBodyClick({
      clientX: 5,
      clientY: 6,
      currentTarget: { contains: () => true },
      target: { closest: () => null },
    }))
    expect(latestProps().touchMenuOpen).toBe(false)
    renderer.unmount()
  })
})
