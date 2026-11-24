import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LandingShellBotAnnotation } from "./landing-shell-bot-annotation"

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

let ioCallback: IntersectionObserverCallback
const observed: Element[] = []

function Shell({ visible, onExited }: { visible: boolean; onExited: () => void }) {
  return (
    <div data-testid="landing-interactive-shell">
      <div data-slot="community-sidebar-panel-content"><button type="button">content</button></div>
      <div data-testid="community-user-bar" />
      <main data-slot="community-conversation-surface"><button type="button" aria-label="Open Alli profile" /></main>
      <LandingShellBotAnnotation scrollRoot={null} visible={visible} onExited={onExited} />
    </div>
  )
}

describe("landing shell bot annotation", () => {
  beforeEach(() => {
    observed.length = 0
    vi.useFakeTimers()
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { ioCallback = cb }
      observe(el: Element) { observed.push(el) }
      disconnect() {}
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "landing-interactive-shell") return rect(0, 0, 1078, 638)
      if (this.dataset.slot === "community-sidebar-panel-content") return rect(56, 0, 319, 580)
      if (this.textContent === "content") return rect(76, 384, 240, 32)
      if (this.dataset.testid === "community-user-bar") return rect(56, 580, 319, 58)
      if (this.dataset.slot === "community-conversation-surface") return rect(375, 50, 703, 588)
      if (this.getAttribute("aria-label") === "Open Alli profile") return rect(385, 388, 40, 40)
      return rect(0, 0, 0, 0)
    })
  })

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it("stays idle until both Alli's avatar and the annotation label enter the viewport, then exits on dismissal", () => {
    const onExited = vi.fn()
    const view = render(<Shell visible onExited={onExited} />)
    act(() => { vi.runAllTimers() })

    const annotation = screen.getByTestId("landing-shell-bot-annotation")
    expect(annotation).toHaveAttribute("data-state", "idle")
    expect(annotation).toHaveTextContent(/Alli is your\s*local agent!/)
    expect(observed).toHaveLength(2)

    // Avatar alone entering keeps it idle until the label also enters.
    act(() => ioCallback([{ target: observed[0], isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(annotation).toHaveAttribute("data-state", "idle")

    act(() => ioCallback([{ target: observed[1], isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(annotation).toHaveAttribute("data-state", "visible")

    view.rerender(<Shell visible={false} onExited={onExited} />)
    expect(annotation).toHaveAttribute("data-state", "exiting")
    act(() => { vi.advanceTimersByTime(340) })
    expect(onExited).toHaveBeenCalledTimes(1)
  })
})
