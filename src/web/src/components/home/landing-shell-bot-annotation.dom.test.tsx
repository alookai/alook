import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LandingShellBotAnnotation } from "./landing-shell-bot-annotation"

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

let ioCallback: IntersectionObserverCallback
const observed: Element[] = []

function DesktopShell({ visible, onShown, onExited }: { visible: boolean; onShown?: () => void; onExited: () => void }) {
  return (
    <div data-testid="landing-interactive-shell">
      <div data-slot="community-sidebar-panel-content"><button type="button">content</button></div>
      <div data-testid="community-user-bar" />
      <main data-slot="community-conversation-surface"><button type="button" aria-label="Open Alli profile" /></main>
      <LandingShellBotAnnotation scrollRoot={null} visible={visible} onShown={onShown} onExited={onExited} />
    </div>
  )
}

function MobileShell({ visible, onShown, onExited }: { visible: boolean; onShown?: () => void; onExited: () => void }) {
  return (
    <div data-testid="landing-interactive-shell">
      <div data-slot="community-sidebar-panel-content"><button type="button">general</button></div>
      <main data-slot="community-conversation-surface">
        <div data-page-swipe-reply-row>
          <button type="button" aria-label="Open Alli profile" />
          <div>
            <button type="button">Alli</button>
            <time>Oct 21, 2026, 9:02 AM</time>
          </div>
        </div>
      </main>
      <LandingShellBotAnnotation scrollRoot={null} visible={visible} onShown={onShown} onExited={onExited} />
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
  })

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it("stays idle until both Alli's avatar and the annotation label enter the viewport, then exits on dismissal", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "landing-interactive-shell") return rect(0, 0, 1078, 638)
      if (this.dataset.slot === "community-sidebar-panel-content") return rect(56, 0, 319, 580)
      if (this.textContent === "content") return rect(76, 384, 240, 32)
      if (this.dataset.testid === "community-user-bar") return rect(56, 580, 319, 58)
      if (this.dataset.slot === "community-conversation-surface") return rect(375, 50, 703, 588)
      if (this.getAttribute("aria-label") === "Open Alli profile") return rect(385, 388, 40, 40)
      return rect(0, 0, 0, 0)
    })

    const onShown = vi.fn()
    const onExited = vi.fn()
    const view = render(<DesktopShell visible onShown={onShown} onExited={onExited} />)
    act(() => { vi.runAllTimers() })

    const annotation = screen.getByTestId("landing-shell-bot-annotation")
    expect(annotation).toHaveAttribute("data-mode", "desktop")
    expect(annotation).toHaveAttribute("data-state", "idle")
    expect(annotation).toHaveTextContent(/Alli is your\s*local agent!/)
    expect(observed).toHaveLength(2)
    expect(onShown).not.toHaveBeenCalled()

    // Avatar alone entering keeps it idle until the label also enters.
    act(() => ioCallback([{ target: observed[0], isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(annotation).toHaveAttribute("data-state", "idle")
    expect(onShown).not.toHaveBeenCalled()

    act(() => ioCallback([{ target: observed[1], isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(annotation).toHaveAttribute("data-state", "visible")
    expect(onShown).toHaveBeenCalledTimes(1)

    view.rerender(<DesktopShell visible={false} onShown={onShown} onExited={onExited} />)
    expect(annotation).toHaveAttribute("data-state", "exiting")
    act(() => { vi.advanceTimersByTime(340) })
    expect(onExited).toHaveBeenCalledTimes(1)
  })

  it("waits for the mobile detail pane slide to settle before showing and reporting onShown", () => {
    let chatLeft = 351
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "landing-interactive-shell") return rect(0, 0, 351, 620)
      if (this.dataset.slot === "community-sidebar-panel-content") return rect(chatLeft - 351, 0, 351, 620)
      if (this.dataset.slot === "community-conversation-surface") return rect(chatLeft, 42, 351, 578)
      if (this.getAttribute("aria-label") === "Open Alli profile") return rect(chatLeft + 11, 429, 40, 40)
      if (this.textContent === "Alli") return rect(chatLeft + 58, 429, 19, 19)
      if (this.tagName === "TIME") return rect(chatLeft + 84, 432, 105, 14)
      return rect(0, 0, 0, 0)
    })

    const onShown = vi.fn()
    const onExited = vi.fn()
    render(<MobileShell visible onShown={onShown} onExited={onExited} />)

    // Still sliding in after fast tap on /general: annotation must not render or arm dismissal yet.
    act(() => { vi.advanceTimersByTime(16) })
    expect(screen.queryByTestId("landing-shell-bot-annotation")).toBeNull()
    expect(onShown).not.toHaveBeenCalled()

    // Slide finishes and lands onscreen.
    chatLeft = 0
    act(() => { vi.advanceTimersByTime(32) })

    const annotation = screen.getByTestId("landing-shell-bot-annotation")
    expect(annotation).toHaveAttribute("data-mode", "mobile")
    expect(annotation).toHaveAttribute("data-state", "idle")
    expect(annotation).toHaveTextContent(/Alli is your\s*local agent!/)
    expect(onShown).not.toHaveBeenCalled()

    act(() => ioCallback(observed.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver))
    expect(annotation).toHaveAttribute("data-state", "visible")
    expect(onShown).toHaveBeenCalledTimes(1)
  })
})
