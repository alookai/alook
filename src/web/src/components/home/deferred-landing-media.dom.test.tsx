import React, { lazy } from "react"
import { renderToString } from "react-dom/server"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeferredLandingMedia, DeferredShellMotion } from "./deferred-landing-media"

const props = { poster: "/landing/posters/server.webp", darkPoster: "/landing/posters/server-dark.webp", width: 1120, height: 660 }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("deferred landing media", () => {
  it("keeps a dimensioned static image in server HTML without invoking the chunk", () => {
    const load = vi.fn()
    const Demo = lazy(load)
    const html = renderToString(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    expect(load).not.toHaveBeenCalled()
    expect(html).toContain('width="1120"')
    expect(html).toContain('height="660"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain(props.darkPoster)
  })

  it.each([0, 1])("loads only on intersection after poster %s decodes and preserves it while pending", async (posterIndex) => {
    let observeCallback: IntersectionObserverCallback = () => undefined
    const disconnect = vi.fn()
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        observeCallback = callback
        expect(options.rootMargin).toBe("100px")
      }
      observe = vi.fn()
      disconnect = disconnect
    })
    let resolve!: (value: { default: () => React.ReactNode }) => void
    const load = vi.fn(() => new Promise<{ default: () => React.ReactNode }>((done) => { resolve = done }))
    const Demo = lazy(load)
    const { container, unmount } = render(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    expect(load).not.toHaveBeenCalled()
    await act(async () => observeCallback([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver))
    expect(load).not.toHaveBeenCalled()
    await act(async () => observeCallback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver))
    expect(load).not.toHaveBeenCalled()
    let finishDecode!: () => void
    const image = container.querySelectorAll("img")[posterIndex]!
    Object.defineProperty(image, "decode", { value: () => new Promise<void>((done) => { finishDecode = done }) })
    await act(async () => fireEvent.load(image))
    expect(load).not.toHaveBeenCalled()
    await act(async () => finishDecode())
    expect(load).toHaveBeenCalledTimes(1)
    expect(container.querySelector("img")?.getAttribute("src")).toBe(props.poster)
    expect(disconnect).toHaveBeenCalled()
    await act(async () => resolve({ default: () => <span>Live demo</span> }))
    expect(screen.getByText("Live demo")).toBeTruthy()
    expect(container.querySelector("img")).toBeNull()
    expect((container.firstElementChild as HTMLElement).style.aspectRatio).toBe("1120 / 660")
    unmount()
    expect(disconnect.mock.calls.length).toBeGreaterThan(1)
  })

  it("activates on intersection when only the dark poster completed before hydration", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockImplementation(function (this: HTMLImageElement) {
      return this.getAttribute("src") === props.darkPoster
    })
    let observeCallback: IntersectionObserverCallback = () => undefined
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { observeCallback = callback }
      observe = vi.fn()
      disconnect = vi.fn()
    })
    const load = vi.fn(async () => ({ default: () => <span>Cached dark demo</span> }))
    const Demo = lazy(load)
    render(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    await act(async () => { await Promise.resolve() })
    expect(load).not.toHaveBeenCalled()
    await act(async () => observeCallback([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver))
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Cached dark demo")).toBeTruthy()
  })

  it("activates without IntersectionObserver and keeps a poster on chunk failure", async () => {
    vi.stubGlobal("IntersectionObserver", undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const Demo = lazy(() => Promise.reject(new Error("offline")))
    const { container } = render(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    fireEvent.error(container.querySelector("img")!)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector("img")?.getAttribute("src")).toBe(props.poster)
    error.mockRestore()
  })
})


it("keeps the below-workspace product poster below hero and interactive Shell priority", () => {
  const html = renderToString(<DeferredShellMotion scene="server" />)
  expect(html).toContain('loading="lazy"')
  expect(html).not.toContain('fetchPriority="high"')
  expect(html).not.toContain('loading="eager"')
})
