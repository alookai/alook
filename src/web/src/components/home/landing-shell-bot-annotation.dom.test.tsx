import { useRef } from "react"
import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LandingShellBotAnnotation } from "./landing-shell-bot-annotation"

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function Harness({ entered, visible, onExited }: { entered: boolean; visible: boolean; onExited: () => void }) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={shellRef}>
      <div data-testid="landing-interactive-shell">
        <div data-community-rail />
        <button type="button">content</button>
        <div data-testid="community-user-bar" />
        <main data-slot="community-conversation-surface">
          <button type="button" aria-label="Open Alli profile" />
        </main>
      </div>
      <LandingShellBotAnnotation shellRef={shellRef} scrollRoot={null} entered={entered} visible={visible} onExited={onExited} />
    </div>
  )
}

describe("landing shell bot annotation", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id))
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "landing-interactive-shell") return rect(0, 0, 1078, 638)
      if ("communityRail" in this.dataset) return rect(0, 0, 56, 638)
      if (this.textContent === "content") return rect(76, 384, 240, 32)
      if (this.dataset.testid === "community-user-bar") return rect(56, 580, 319, 58)
      if (this.dataset.slot === "community-conversation-surface") return rect(375, 50, 703, 588)
      if (this.getAttribute("aria-label") === "Open Alli profile") return rect(385, 388, 40, 40)
      return rect(0, 0, 0, 0)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("stays idle until entered, draws in blank sidebar space, and exits cleanly on dismissal", () => {
    const onExited = vi.fn()
    const view = render(<Harness entered={false} visible onExited={onExited} />)
    act(() => { vi.runAllTimers() })

    const annotation = screen.getByTestId("landing-shell-bot-annotation")
    expect(annotation).toHaveAttribute("data-state", "idle")
    expect(annotation).toHaveTextContent(/Alli is your\s*local agent!/)

    view.rerender(<Harness entered visible onExited={onExited} />)
    expect(screen.getByTestId("landing-shell-bot-annotation")).toHaveAttribute("data-state", "visible")

    view.rerender(<Harness entered visible={false} onExited={onExited} />)
    expect(screen.getByTestId("landing-shell-bot-annotation")).toHaveAttribute("data-state", "exiting")
    expect(onExited).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(340) })
    expect(onExited).toHaveBeenCalledTimes(1)
  })
})
