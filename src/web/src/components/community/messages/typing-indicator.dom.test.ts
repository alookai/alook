import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, mockElementGeometry, render, screen } from "@/test/react-dom-harness"
import { TypingIndicator } from "./typing-indicator"

describe("TypingIndicator", () => {
  it("keeps a long single name in one bounded live status", () => {
    render(createElement(TypingIndicator, {
      names: ["A teammate with an exceptionally long account name"],
    }))

    const status = screen.getByTestId(tid.typingIndicator)
    expect(status).toHaveAttribute("role", "status")
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toHaveAttribute("aria-atomic", "true")
    expect(status).toHaveClass("max-w-full")
    const label = status.querySelector(".min-w-0.truncate")
    expect(label).toHaveTextContent("is typing…")
  })

  it("summarizes four or more typers without rendering every long name", () => {
    render(createElement(TypingIndicator, {
      names: ["Alice", "Bob", "Carol", "Dorothy"],
    }))

    const status = screen.getByTestId(tid.typingIndicator)
    expect(status).toHaveTextContent("4 people are typing…")
    expect(status).not.toHaveTextContent("Dorothy")
  })

  it("uses the floating bottom-rail pill footprint", () => {
    render(createElement(TypingIndicator, { names: ["Alice"] }))

    const status = screen.getByTestId(tid.typingIndicator)
    expect(status).toHaveClass("h-8", "rounded-full", "shadow-(--e1)")
    expect(status.querySelector(".min-w-0.truncate")).not.toHaveClass("hidden")
  })

  it("binds passive hover/press feedback across none -> typing -> none -> typing, and cleans up", () => {
    const pointer = (type: string, x: number, y: number) => {
      act(() => { window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y })) })
    }
    const pill = () => {
      const el = screen.getByTestId(tid.typingIndicator)
      mockElementGeometry(el, { left: 0, top: 0, width: 100, height: 32 })
      return el
    }
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const view = render(createElement(TypingIndicator, { names: [] }))
    expect(screen.queryByTestId(tid.typingIndicator)).toBeNull()

    for (let round = 0; round < 2; round += 1) {
      view.rerender(createElement(TypingIndicator, { names: ["Alice"] }))
      const el = pill()
      pointer("pointermove", 10, 10)
      expect(el).toHaveAttribute("data-hover")
      pointer("pointerdown", 10, 10)
      expect(el).toHaveAttribute("data-pressed")
      pointer("pointerup", 10, 10)
      expect(el).not.toHaveAttribute("data-pressed")
      pointer("pointermove", 300, 300)
      expect(el).not.toHaveAttribute("data-hover")

      const before = removeSpy.mock.calls.length
      view.rerender(createElement(TypingIndicator, { names: [] }))
      const removed = removeSpy.mock.calls.slice(before).map(([type]) => type)
      expect(removed).toEqual(expect.arrayContaining(["pointermove", "pointerdown", "pointerup", "pointercancel"]))
    }

    view.rerender(createElement(TypingIndicator, { names: ["Bob"] }))
    const before = removeSpy.mock.calls.length
    view.unmount()
    const removed = removeSpy.mock.calls.slice(before).map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(["pointermove", "pointerdown", "pointerup", "pointercancel"]))
    removeSpy.mockRestore()
  })
})
