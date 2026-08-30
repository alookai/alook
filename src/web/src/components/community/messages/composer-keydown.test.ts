import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ normalize: vi.fn() }))

vi.mock("./consecutive-hard-break", () => ({
  normalizeConsecutiveTerminalHardBreak: (...args: unknown[]) =>
    mocks.normalize(...args),
}))

import { handleComposerEditorKeyDown } from "./composer-keydown"

function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    hoverCapable: true,
    channelRefOpen: false,
    isForumThreadBody: false,
    mentionOpen: false,
    send: vi.fn(),
    liftEmptyBlock: vi.fn(() => false),
    splitListItem: vi.fn(() => false),
    undoInputRule: vi.fn(() => false),
    ...overrides,
  }
}

describe("handleComposerEditorKeyDown", () => {
  beforeEach(() => {
    mocks.normalize.mockReset()
    mocks.normalize.mockReturnValue(false)
  })

  it("keeps hover Enter as send before list keymaps", () => {
    const key = event()
    const opts = options()
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(true)
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(opts.send).toHaveBeenCalledOnce()
    expect(opts.splitListItem).not.toHaveBeenCalled()
  })

  it("routes unshifted Mod-z through official input-rule undo before history", () => {
    const key = event({ key: "z", metaKey: true })
    const opts = options({ undoInputRule: vi.fn(() => true) })
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(true)
    expect(opts.undoInputRule).toHaveBeenCalledOnce()
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.normalize).not.toHaveBeenCalled()
  })

  it("leaves Mod-z to normal editor history when no input rule can be undone", () => {
    const key = event({ key: "z", ctrlKey: true })
    const opts = options()
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(false)
    expect(opts.undoInputRule).toHaveBeenCalledOnce()
    expect(key.preventDefault).not.toHaveBeenCalled()
  })

  it("delegates hover Shift+Enter to official splitListItem", () => {
    const key = event({ shiftKey: true })
    const opts = options({ splitListItem: vi.fn(() => true) })
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(true)
    expect(opts.splitListItem).toHaveBeenCalledOnce()
    expect(opts.liftEmptyBlock).not.toHaveBeenCalled()
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.normalize).not.toHaveBeenCalled()
  })

  it("uses official liftEmptyBlock after splitListItem declines an empty top-level item", () => {
    const key = event({ shiftKey: true })
    const opts = options({ liftEmptyBlock: vi.fn(() => true) })
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(true)
    expect(opts.splitListItem).toHaveBeenCalledOnce()
    expect(opts.liftEmptyBlock).toHaveBeenCalledOnce()
    expect(opts.splitListItem.mock.invocationCallOrder[0]).toBeLessThan(
      opts.liftEmptyBlock.mock.invocationCallOrder[0],
    )
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.normalize).not.toHaveBeenCalled()
  })

  it("falls through to the existing hard-break path when both official commands decline", () => {
    const key = event({ shiftKey: true })
    const view = { identity: "view" }
    const opts = options()
    mocks.normalize.mockReturnValue(true)
    expect(handleComposerEditorKeyDown(view as never, key, opts)).toBe(true)
    expect(opts.splitListItem).toHaveBeenCalledOnce()
    expect(opts.liftEmptyBlock).toHaveBeenCalledOnce()
    expect(mocks.normalize).toHaveBeenCalledWith(view, key)
  })

  it("leaves coarse Enter for Tiptap ListItem and never calls the desktop adapter", () => {
    const key = event()
    const opts = options({ hoverCapable: false })
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(false)
    expect(opts.send).not.toHaveBeenCalled()
    expect(opts.splitListItem).not.toHaveBeenCalled()
    expect(opts.liftEmptyBlock).not.toHaveBeenCalled()
  })

  it.each([
    { mentionOpen: true },
    { channelRefOpen: true },
  ])("keeps suggestion ownership for %o", (override) => {
    const key = event({ shiftKey: true })
    const opts = options(override)
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(false)
    expect(opts.splitListItem).not.toHaveBeenCalled()
    expect(opts.liftEmptyBlock).not.toHaveBeenCalled()
    expect(mocks.normalize).not.toHaveBeenCalled()
  })

  it("does not send or split during IME composition", () => {
    const key = event({ shiftKey: true, isComposing: true })
    const opts = options()
    expect(handleComposerEditorKeyDown({} as never, key, opts)).toBe(false)
    expect(opts.send).not.toHaveBeenCalled()
    expect(opts.splitListItem).not.toHaveBeenCalled()
    expect(opts.liftEmptyBlock).not.toHaveBeenCalled()
    expect(mocks.normalize).not.toHaveBeenCalled()
  })

  it("keeps forum Shift+Enter submit and forum Enter newline unchanged", () => {
    const opts = options({ isForumThreadBody: true })
    const submit = event({ shiftKey: true })
    expect(handleComposerEditorKeyDown({} as never, submit, opts)).toBe(true)
    expect(opts.send).toHaveBeenCalledOnce()
    expect(opts.splitListItem).not.toHaveBeenCalled()

    const newline = event()
    expect(handleComposerEditorKeyDown({} as never, newline, opts)).toBe(false)
  })
})
