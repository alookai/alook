import React from "react"
import { act, render } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ComposerOverlayShell } from "./composer-overlay-shell"

let resize: ResizeObserverCallback | null = null
let shellHeight = 60
let overlayHeight = 60
let offsetHeightDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  resize = null
  shellHeight = 60
  overlayHeight = 60
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const slot = (this as HTMLElement).dataset.slot
      if (slot === "community-composer-shell") return shellHeight
      if (slot === "community-composer-overlay") return overlayHeight
      return 0
    },
  })
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe() {}
    disconnect() {}
    unobserve() {}
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (offsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor)
  } else {
    delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight
  }
})

describe("ComposerOverlayShell", () => {
  it("reserves the collapsed height and reports only upward overlap", () => {
    const onOverlapChange = vi.fn()
    const renderer = render(
      <ComposerOverlayShell onOverlapChange={onOverlapChange} data-testid="shell">
        <div>composer</div>
      </ComposerOverlayShell>,
    )

    const shell = renderer.getByTestId("shell")
    expect(shell).toHaveClass("relative", "shrink-0")
    expect(shell.className).toContain("h-[calc(3.75rem+var(--app-safe-area-bottom))]")
    expect(shell).toHaveClass("sm:h-15")
    expect(shell.querySelector('[data-slot="community-composer-overlay"]'))
      .toHaveClass("absolute", "inset-x-0", "bottom-0", "z-30")
    expect(onOverlapChange).toHaveBeenLastCalledWith(0)

    overlayHeight = 156
    act(() => resize?.([], {} as ResizeObserver))
    expect(onOverlapChange).toHaveBeenLastCalledWith(96)

    overlayHeight = 84
    act(() => resize?.([], {} as ResizeObserver))
    expect(onOverlapChange).toHaveBeenLastCalledWith(24)

    overlayHeight = 48
    act(() => resize?.([], {} as ResizeObserver))
    expect(onOverlapChange).toHaveBeenLastCalledWith(0)
  })
})
