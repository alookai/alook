import { describe, it, expect, vi } from "vitest"
import { isImeConfirming, onEnterSubmit } from "./ime"

describe("isImeConfirming", () => {
  it("is true when a React synthetic event's nativeEvent is composing", () => {
    expect(isImeConfirming({ nativeEvent: { isComposing: true } })).toBe(true)
  })

  it("is true when a native KeyboardEvent is composing", () => {
    expect(isImeConfirming({ isComposing: true })).toBe(true)
  })

  it("prefers nativeEvent over the top-level flag", () => {
    expect(isImeConfirming({ isComposing: true, nativeEvent: { isComposing: false } })).toBe(false)
  })

  it("is false when nothing is composing", () => {
    expect(isImeConfirming({ nativeEvent: { isComposing: false } })).toBe(false)
    expect(isImeConfirming({ isComposing: false })).toBe(false)
    expect(isImeConfirming({})).toBe(false)
  })
})

describe("onEnterSubmit", () => {
  const key = (over: Record<string, unknown>) => ({
    key: "Enter",
    preventDefault: vi.fn(),
    ...over,
  })

  it("does NOT call fn while confirming an IME candidate", () => {
    const fn = vi.fn()
    onEnterSubmit(fn)(key({ nativeEvent: { isComposing: true } }))
    expect(fn).not.toHaveBeenCalled()
  })

  it("calls fn on a clean Enter and prevents default", () => {
    const fn = vi.fn()
    const e = key({ nativeEvent: { isComposing: false } })
    onEnterSubmit(fn)(e)
    expect(fn).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it("calls onEscape on Escape", () => {
    const fn = vi.fn()
    const onEscape = vi.fn()
    onEnterSubmit(fn, { onEscape })(key({ key: "Escape" }))
    expect(onEscape).toHaveBeenCalledOnce()
    expect(fn).not.toHaveBeenCalled()
  })

  it("ignores Shift+Enter by default but honors allowShift", () => {
    const fn = vi.fn()
    onEnterSubmit(fn)(key({ shiftKey: true }))
    expect(fn).not.toHaveBeenCalled()

    const fn2 = vi.fn()
    onEnterSubmit(fn2, { allowShift: true })(key({ shiftKey: true }))
    expect(fn2).toHaveBeenCalledOnce()
  })
})
