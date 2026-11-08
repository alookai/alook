import { afterEach, expect, it, vi } from "vitest"
import { createElement } from "react"
import { render } from "@/test/react-dom-harness"
import { observeVisibilitySentinel } from "./observe-visibility-sentinel"

afterEach(() => vi.unstubAllGlobals())
it("uses the caller root and ignores callbacks after exact observer cleanup", () => {
  const callbacks: IntersectionObserverCallback[] = [], observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  const construct = vi.fn(function (callback: IntersectionObserverCallback, _options: IntersectionObserverInit) {
    callbacks.push(callback)
    const observer = { observe: vi.fn(), disconnect: vi.fn() }; observers.push(observer); return observer
  })
  vi.stubGlobal("IntersectionObserver", construct)
  const view = render(createElement("section", null, createElement("i"), createElement("i")))
  const root = view.container.firstElementChild!, a = root.children[0], b = root.children[1], visible = vi.fn()
  const releaseA = observeVisibilitySentinel(root, a, visible)
  expect(construct).toHaveBeenCalledWith(expect.any(Function), { root, rootMargin: "100px" })
  expect(observers[0].observe).toHaveBeenCalledWith(a)
  callbacks[0]([{ isIntersecting: false }] as IntersectionObserverEntry[], observers[0] as never)
  expect(visible).not.toHaveBeenCalled()
  callbacks[0]([{ isIntersecting: false }, { isIntersecting: true }] as IntersectionObserverEntry[], observers[0] as never)
  expect(visible).toHaveBeenCalledOnce()
  releaseA()
  const releaseB = observeVisibilitySentinel(root, b, visible)
  callbacks[0]([{ isIntersecting: true }] as IntersectionObserverEntry[], observers[0] as never)
  expect(visible).toHaveBeenCalledOnce()
  expect(observers[0].disconnect).toHaveBeenCalledOnce()
  expect(observers[1].observe).toHaveBeenCalledWith(b)
  releaseB()
  callbacks[1]([{ isIntersecting: true }] as IntersectionObserverEntry[], observers[1] as never)
  expect(visible).toHaveBeenCalledOnce()
  expect(observers[1].disconnect).toHaveBeenCalledOnce()
})
