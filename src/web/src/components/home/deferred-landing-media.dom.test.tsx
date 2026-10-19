import React, { lazy } from "react"
import { renderToString } from "react-dom/server"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeferredLandingMedia } from "./deferred-landing-media"

const props = { poster: "/landing/posters/server.webp", width: 1120, height: 660 }
afterEach(() => vi.unstubAllGlobals())

describe("deferred landing media", () => {
  it("keeps a dimensioned static image in server HTML without invoking the chunk", () => {
    const load = vi.fn()
    const Demo = lazy(load)
    const html = renderToString(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    expect(load).not.toHaveBeenCalled()
    expect(html).toContain('width="1120"')
    expect(html).toContain('height="660"')
    expect(html).toContain('loading="lazy"')
  })

  it("loads only on intersection and preserves the poster while the chunk is pending", async () => {
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
    const image = container.querySelector("img")!
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
