import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollBar,
} from "./scroll-area"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ScrollArea", () => {
  it("renders a zero-gutter Base UI scroll viewport and ScrollAreaContent without fit-content minWidth", () => {
    const view = render(
      <ScrollArea className="h-40 w-40" viewportProps={{ "data-testid": "viewport" }}>
        <div className="h-96">Tall content</div>
      </ScrollArea>,
    )

    const root = view.container.querySelector('[data-slot="scroll-area"]')
    const viewport = view.getByTestId("viewport")
    const content = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-content"]')
    expect(root).not.toBeNull()
    expect(viewport).toHaveAttribute("data-slot", "scroll-area-viewport")
    expect(viewport).toHaveClass("scrollbar-none", "overflow-x-clip", "overflow-y-auto")
    expect(viewport.style.overflow).toBe("")
    expect(content).not.toBeNull()
    expect(content).toHaveClass("min-w-0")
    expect(content!.style.minWidth).toBe("")
  })

  it("renders an overlay scrollbar with hover/scroll reveal and semantic thumb tokens when mounted", () => {
    const view = render(
      <ScrollAreaRoot className="h-40 w-40">
        <ScrollAreaViewport data-testid="custom-viewport">
          <ScrollAreaContent>
            <div className="h-96">Tall content</div>
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar keepMounted orientation="vertical" />
      </ScrollAreaRoot>,
    )

    const scrollbar = view.container.querySelector('[data-slot="scroll-area-scrollbar"]')
    const thumb = view.container.querySelector('[data-slot="scroll-area-thumb"]')
    expect(scrollbar).not.toBeNull()
    expect(scrollbar).toHaveAttribute("aria-hidden", "true")
    expect(scrollbar).toHaveClass(
      "z-20",
      "opacity-0",
      "pointer-events-none",
      "data-hovering:opacity-100",
      "data-hovering:pointer-events-auto",
      "data-scrolling:opacity-100",
      "data-scrolling:pointer-events-auto",
      "motion-reduce:transition-none",
    )
    expect(thumb).not.toBeNull()
    expect(thumb).toHaveClass(
      "bg-foreground/20",
      "hover:bg-foreground/35",
      "active:bg-foreground/45",
    )
  })

  it("mounts the vertical overlay scrollbar when async content grows past viewport height", async () => {
    const observers: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = []
    vi.stubGlobal("ResizeObserver", class {
      private readonly entry: { callback: ResizeObserverCallback; targets: Element[] }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] }
        observers.push(this.entry)
      }
      observe(target: Element) {
        this.entry.targets.push(target)
      }
      disconnect() {}
      unobserve() {}
    })

    let scrollHeight = 120
    const clientHeight = 200
    const view = render(
      <ScrollAreaRoot className="h-50 w-40">
        <ScrollAreaViewport data-testid="async-viewport">
          <ScrollAreaContent data-testid="async-content">
            <div>Initial short list</div>
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar orientation="vertical" />
      </ScrollAreaRoot>,
    )

    const viewport = view.getByTestId("async-viewport")
    const content = view.getByTestId("async-content")
    Object.defineProperty(viewport, "clientHeight", { configurable: true, get: () => clientHeight })
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => scrollHeight })
    Object.defineProperty(viewport, "clientWidth", { configurable: true, get: () => 200 })
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, get: () => 200 })

    const contentObserver = observers.find((entry) => entry.targets.includes(content))
    expect(contentObserver).toBeDefined()

    await act(async () => {
      await Promise.resolve()
      contentObserver!.callback([], {} as ResizeObserver)
    })
    expect(view.container.querySelector('[data-slot="scroll-area-scrollbar"]')).toBeNull()

    scrollHeight = 1200
    await act(async () => {
      contentObserver!.callback([], {} as ResizeObserver)
      await Promise.resolve()
    })
    expect(view.container.querySelector('[data-slot="scroll-area-scrollbar"]')).not.toBeNull()
  })
})
