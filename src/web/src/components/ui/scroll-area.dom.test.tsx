import globalsCss from "../../app/globals.css?raw"
import rootLayoutSource from "../../app/layout.tsx?raw"
import { CSPProvider } from "@base-ui/react/csp-provider"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollBar,
} from "./scroll-area"

afterEach(() => {
  vi.restoreAllMocks()
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

  it("skips unused overflow CSS variable writes and subtree getAnimations scans while keeping thumb positioning and overflow edges", async () => {
    const setPropertySpy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty")
    const originalGetAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations")
    const getAnimationsSpy = vi.fn(() => [])
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      writable: true,
      value: getAnimationsSpy,
    })

    try {
      const view = render(
        <ScrollArea className="h-50 w-40" viewportProps={{ "data-testid": "perf-viewport" }}>
          <div className="h-240">Tall content</div>
        </ScrollArea>,
      )

      const viewport = view.getByTestId("perf-viewport")
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 })
      Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1200 })
      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 200 })
      Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 200 })

      await act(async () => {
        await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 10))
      })

      const scrollbar = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]')
      const thumb = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]')
      expect(scrollbar).not.toBeNull()
      expect(thumb).not.toBeNull()

      Object.defineProperty(scrollbar!, "offsetHeight", { configurable: true, value: 200 })
      Object.defineProperty(thumb!, "offsetHeight", { configurable: true, value: 33 })

      await act(async () => {
        viewport.scrollTop = 0
        fireEvent.scroll(viewport)
        await Promise.resolve()
      })
      expect(thumb!.style.transform).toBe("translate3d(0,0px,0)")
      expect(viewport).not.toHaveAttribute("data-overflow-y-start")
      expect(viewport).toHaveAttribute("data-overflow-y-end")

      await act(async () => {
        viewport.scrollTop = 500
        fireEvent.scroll(viewport)
        await Promise.resolve()
      })
      expect(thumb!.style.transform).not.toBe("translate3d(0,0px,0)")
      expect(viewport).toHaveAttribute("data-overflow-y-start")
      expect(viewport).toHaveAttribute("data-overflow-y-end")

      const overflowVarWrites = setPropertySpy.mock.calls.filter(([prop]) =>
        typeof prop === "string" && prop.startsWith("--scroll-area-overflow-"),
      )
      expect(overflowVarWrites).toEqual([])
      expect(viewport.style.getPropertyValue("--scroll-area-overflow-x-start")).toBe("")
      expect(viewport.style.getPropertyValue("--scroll-area-overflow-x-end")).toBe("")
      expect(viewport.style.getPropertyValue("--scroll-area-overflow-y-start")).toBe("")
      expect(viewport.style.getPropertyValue("--scroll-area-overflow-y-end")).toBe("")
      expect(getAnimationsSpy).not.toHaveBeenCalled()
    } finally {
      if (originalGetAnimations) {
        Object.defineProperty(HTMLElement.prototype, "getAnimations", originalGetAnimations)
      } else {
        delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
      }
    }
  })

  it("supports hover reveal and pointer thumb dragging", async () => {
    const view = render(
      <ScrollArea className="h-50 w-40" viewportProps={{ "data-testid": "drag-viewport" }}>
        <div className="h-240">Draggable content</div>
      </ScrollArea>,
    )

    const root = view.container.querySelector<HTMLElement>('[data-slot="scroll-area"]')!
    const viewport = view.getByTestId("drag-viewport")
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 })
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 200 })
    Object.defineProperty(viewport, "scrollWidth", { configurable: true, value: 200 })

    await act(async () => {
      await Promise.resolve()
    })

    const scrollbar = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]')!
    const thumb = view.container.querySelector<HTMLElement>('[data-slot="scroll-area-thumb"]')!
    Object.defineProperty(scrollbar, "offsetHeight", { configurable: true, value: 200 })
    Object.defineProperty(thumb, "offsetHeight", { configurable: true, value: 40 })
    thumb.setPointerCapture = vi.fn()
    thumb.releasePointerCapture = vi.fn()
    thumb.hasPointerCapture = vi.fn(() => true)

    await act(async () => {
      fireEvent.pointerEnter(root, { pointerType: "mouse" })
    })
    expect(scrollbar).toHaveAttribute("data-hovering")

    await act(async () => {
      fireEvent.pointerDown(thumb, { button: 0, pointerId: 1, clientY: 10 })
      fireEvent.pointerMove(thumb, { pointerId: 1, buttons: 1, clientY: 90 })
    })
    expect(viewport.scrollTop).toBe(400)
    expect(scrollbar).toHaveAttribute("data-scrolling")

    await act(async () => {
      fireEvent.pointerUp(thumb, { pointerId: 1 })
    })
    expect(scrollbar).not.toHaveAttribute("data-scrolling")
  })

  it("omits runtime scrollbar style elements under CSPProvider while globals.css covers .base-ui-disable-scrollbar", async () => {
    const view = render(
      <CSPProvider disableStyleElements>
        <ScrollArea className="h-40 w-40" viewportProps={{ "data-testid": "csp-viewport" }}>
          <div className="h-96">Tall content</div>
        </ScrollArea>
      </CSPProvider>,
    )

    await act(async () => {
      await Promise.resolve()
    })

    const viewport = view.getByTestId("csp-viewport")
    expect(viewport).toHaveClass("base-ui-disable-scrollbar", "scrollbar-none")
    expect(view.container.querySelector("style")).toBeNull()
    expect(globalsCss).toMatch(/\.base-ui-disable-scrollbar\s*\{[^}]*scrollbar-width:\s*none/)
    expect(globalsCss).toMatch(/\.base-ui-disable-scrollbar::-webkit-scrollbar\s*\{[^}]*display:\s*none/)
    expect(rootLayoutSource).toContain("<CSPProvider disableStyleElements>")
  })
})
