import React, { lazy } from "react"
import { renderToString } from "react-dom/server"
import { act, fireEvent, render, screen, waitFor } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeferredLandingMedia, DeferredShellMotion } from "./deferred-landing-media"

const props = { poster: "/landing/posters/server.webp", darkPoster: "/landing/posters/server-dark.webp", width: 1120, height: 660 }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function ssrPosters(html: string) {
  const template = document.createElement("template")
  template.innerHTML = html
  return Array.from(template.content.querySelectorAll("img"))
}

function rootMarginPixels(rootMargin: string | undefined) {
  const style = document.createElement("div").style
  style.margin = rootMargin ?? "0px"
  const pixelsPerUnit: Partial<Record<string, number>> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 }
  return [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].map((length) => {
    const parsed = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]+)$/i.exec(length)
    if (!parsed) return Number.NaN
    const factor = pixelsPerUnit[parsed[2].toLowerCase()]
    return factor === undefined ? Number.NaN : Number(parsed[1]) * factor
  })
}

describe("deferred landing media", () => {
  it("keeps a dimensioned static image in server HTML without invoking the chunk", () => {
    const load = vi.fn()
    const Demo = lazy(load)
    const html = renderToString(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    expect(load).not.toHaveBeenCalled()
    const images = ssrPosters(html)
    expect(images).toHaveLength(2)
    for (const src of [props.poster, props.darkPoster]) {
      const image = images.find((candidate) => candidate.getAttribute("src") === src)
      expect(image).toBeDefined()
      expect(image?.getAttribute("width")).toBe(String(props.width))
      expect(image?.getAttribute("height")).toBe(String(props.height))
      expect(image?.getAttribute("loading")).toBe("lazy")
    }
  })

  it.each([0, 1])("loads only on intersection after poster %s decodes and preserves it while pending", async (posterIndex) => {
    const observers: Array<{ targets: Set<Element>; intersect: (active: boolean) => void }> = []
    vi.stubGlobal("IntersectionObserver", class {
      targets = new Set<Element>()
      callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
        this.callback = callback
        for (const margin of rootMarginPixels(options.rootMargin)) expect(margin).toBeCloseTo(100, 10)
        observers.push(this)
      }
      observe(target: Element) { this.targets.add(target) }
      unobserve(target: Element) { this.targets.delete(target) }
      disconnect() { this.targets.clear() }
      intersect(isIntersecting: boolean) {
        if (!this.targets.size) return
        const entries = Array.from(this.targets, (target) => ({ target, isIntersecting }))
        this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
      }
    })
    const intersect = (active: boolean) => { for (const observer of observers) observer.intersect(active) }
    let resolve!: (value: { default: () => React.ReactNode }) => void
    const load = vi.fn(() => new Promise<{ default: () => React.ReactNode }>((done) => { resolve = done }))
    const Demo = lazy(load)
    const { container, rerender, unmount } = render(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>)
    expect(observers.some((observer) => observer.targets.has(container.firstElementChild!))).toBe(true)
    expect(load).not.toHaveBeenCalled()
    await act(async () => intersect(false))
    expect(load).not.toHaveBeenCalled()
    await act(async () => intersect(true))
    expect(load).not.toHaveBeenCalled()
    let finishDecode!: () => void
    const image = container.querySelectorAll("img")[posterIndex]!
    Object.defineProperty(image, "decode", { value: () => new Promise<void>((done) => { finishDecode = done }) })
    await act(async () => fireEvent.load(image))
    expect(load).not.toHaveBeenCalled()
    await act(async () => finishDecode())
    expect(load).toHaveBeenCalledTimes(1)
    expect(container.querySelector("img")?.getAttribute("src")).toBe(props.poster)
    expect(observers.flatMap((observer) => Array.from(observer.targets))).toEqual([])
    await act(async () => resolve({ default: () => <span>Live demo</span> }))
    expect(screen.getByText("Live demo")).toBeTruthy()
    expect(container.querySelector("img")).toBeNull()
    expect((container.firstElementChild as HTMLElement).style.aspectRatio).toBe("1120 / 660")

    const idleLoad = vi.fn(async () => ({ default: () => <span>Unadmitted demo</span> }))
    const IdleDemo = lazy(idleLoad)
    rerender(<DeferredLandingMedia key="unadmitted" {...props}><IdleDemo /></DeferredLandingMedia>)
    expect(idleLoad).not.toHaveBeenCalled()
    expect(observers.some((observer) => observer.targets.has(container.firstElementChild!))).toBe(true)
    unmount()
    expect(observers.flatMap((observer) => Array.from(observer.targets))).toEqual([])
    expect(idleLoad).not.toHaveBeenCalled()
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

  it("activates without IntersectionObserver and keeps a poster on chunk failure", async (context) => {
    vi.stubGlobal("IntersectionObserver", undefined)
    const failure = new Error("offline")
    const caught: unknown[] = []
    context.onTestFinished(() => { for (const error of caught) expect(error).toBe(failure) })
    const load = vi.fn(async () => { throw failure })
    const Demo = lazy(load)
    const { container } = render(<DeferredLandingMedia {...props}><Demo /></DeferredLandingMedia>, {
      onCaughtError: (error) => { caught.push(error) },
    })
    await act(async () => fireEvent.error(container.querySelector("img")!))
    expect(load).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(caught.some((error) => error === failure)).toBe(true))
    expect(container.querySelector("img")?.getAttribute("src")).toBe(props.poster)
  })
})


it("keeps the below-workspace product poster below hero and interactive Shell priority", () => {
  const html = renderToString(<DeferredShellMotion scene="server" />)
  const images = ssrPosters(html)
  expect(images).toHaveLength(2)
  for (const src of [props.poster, props.darkPoster]) {
    const image = images.find((candidate) => candidate.getAttribute("src") === src)
    expect(image).toBeDefined()
    expect(image?.getAttribute("loading")).toBe("lazy")
    expect(image?.getAttribute("fetchpriority")).toBe("auto")
  }
})
