import { describe, expect, it, vi } from "vitest"
import { createSuggestionCaretRectResolver } from "./suggestion-caret-anchor"

describe("createSuggestionCaretRectResolver", () => {
  it("anchors to the live collapsed selection endpoint instead of the multiline suggestion range", () => {
    const selection = { head: 42, to: 42 }
    const coordsAtPos = vi.fn((position: number) => ({
      top: position * 10,
      bottom: position * 10 + 20,
      left: 80,
      right: 80,
    }))
    const rangeRect = vi.fn(() => ({ top: 100 } as DOMRect))
    const getRect = createSuggestionCaretRectResolver({
      editor: { state: { selection }, view: { coordsAtPos } },
      range: { to: 12 },
      clientRect: rangeRect,
    })

    const initialRect = getRect?.()
    expect(initialRect).toMatchObject({
      top: 420,
      bottom: 440,
      left: 80,
      right: 80,
      width: 0,
      height: 20,
    })
    expect(coordsAtPos).toHaveBeenLastCalledWith(42)
    expect(rangeRect).not.toHaveBeenCalled()
    expect(initialRect?.toJSON()).toEqual({
      top: 420,
      bottom: 440,
      left: 80,
      right: 80,
    })

    selection.head = 57
    selection.to = 57
    expect(getRect?.()).toMatchObject({ top: 570, bottom: 590 })
    expect(coordsAtPos).toHaveBeenLastCalledWith(57)
  })

  it("falls back to the range rect when the editor is absent or tearing down", () => {
    const fallback = { top: 10, bottom: 20, left: 30, right: 30 } as DOMRect
    const clientRect = vi.fn(() => fallback)
    expect(createSuggestionCaretRectResolver({ clientRect })).toBe(clientRect)

    const getRect = createSuggestionCaretRectResolver({
      editor: {
        state: { selection: { to: 9 } },
        view: { coordsAtPos: () => { throw new Error("destroyed") } },
      },
      clientRect,
    })
    expect(getRect?.()).toBe(fallback)

    const missingPosition = createSuggestionCaretRectResolver({
      editor: {
        state: { selection: {} },
        view: { coordsAtPos: vi.fn() },
      },
      clientRect,
    })
    expect(missingPosition?.()).toBe(fallback)
  })
})
