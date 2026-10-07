import React from "react"
import { afterEach, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { useRemoteImageAttempt } from "./remote-image-attempt"
import { RemoteContentImage } from "./remote-image"

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function pixels(image: HTMLImageElement, decode: () => Promise<void>) {
  Object.defineProperties(image, {
    naturalWidth: { value: 320, configurable: true },
    naturalHeight: { value: 200, configurable: true },
    decode: { value: decode, configurable: true },
  })
}
let callbacks: ReturnType<typeof useRemoteImageAttempt>
function Owner({ node = "first" }: { node?: string }) {
  const next = useRemoteImageAttempt({ timeoutMs: 50 })
  React.useLayoutEffect(() => { callbacks = next }, [next])
  const [status, attempt, , ref, onLoad, onError] = next
  return React.createElement("img", { key: node, ref, src: "/same.png", "data-state": status, "data-attempt": attempt, onLoad, onError })
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it("rejects successful and failed callbacks from a replaced node in the same attempt", async () => {
  const waiting = deferred()
  const view = render(React.createElement(Owner))
  const old = view.container.querySelector("img")!
  const oldLoad = callbacks[4], oldError = callbacks[5]
  const decoder = vi.fn(() => waiting.promise)
  pixels(old, decoder)
  fireEvent.load(old)
  view.rerender(React.createElement(Owner, { node: "replacement" }))
  const current = view.container.querySelector("img")!
  act(() => { oldLoad({ currentTarget: old } as React.SyntheticEvent<HTMLImageElement>); oldError({ currentTarget: old } as React.SyntheticEvent<HTMLImageElement>) })
  expect(decoder).toHaveBeenCalledOnce()
  expect(current.dataset.state).toBe("pending")
  fireEvent.error(current)
  await act(async () => { waiting.resolve(); await waiting.promise })
  expect(current.dataset.state).toBe("error")
  pixels(current, async () => {})
  fireEvent.load(current)
  await act(async () => { await Promise.resolve() })
  expect(current.dataset.state).toBe("ready")
  fireEvent.error(current)
  expect(current.dataset.state).toBe("ready")
})

it.each(["timeout", "load", "decode"])("recovers a current node after %s failure and keeps preview separate from Retry", async (failure) => {
  vi.useFakeTimers()
  const waiting = deferred(), preview = vi.fn(), ready = vi.fn()
  const view = render(React.createElement(RemoteContentImage, { src: "/source?identity=7", alt: "Photo", loading: "eager", timeoutMs: 50, onActivate: preview, onReady: ready }))
  const image = view.container.querySelector("img")!, parent = image.parentElement
  if (failure === "timeout") {
    pixels(image, () => waiting.promise)
    fireEvent.load(image)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  } else if (failure === "load") {
    fireEvent.error(image)
  } else {
    pixels(image, async () => { throw new Error("decode") })
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
  }
  expect(image.dataset.remoteImageState).toBe("error")
  expect(view.container.querySelector("img")).toBe(image)
  expect(image.parentElement).toBe(parent)
  fireEvent.click(view.getByRole("button", { name: "Open Photo" }))
  expect(preview).toHaveBeenCalledOnce()
  if (failure === "timeout") await act(async () => { waiting.resolve(); await waiting.promise })
  else {
    pixels(image, async () => {})
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
  }
  expect(image.dataset.remoteImageState).toBe("ready")
  expect(ready).toHaveBeenCalledOnce()
  fireEvent.error(image)
  expect(image.dataset.remoteImageState).toBe("ready")
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
})

it("fences Retry, source replacement and unmount while allowing only the new source to settle", async () => {
  const oldDecode = deferred(), retryDecode = deferred(), ready = vi.fn(), preview = vi.fn()
  const props = { alt: "Photo", loading: "eager" as const, onReady: ready, onActivate: preview }
  const view = render(React.createElement(RemoteContentImage, { ...props, src: "/first?version=1" }))
  const old = view.container.querySelector("img")!
  pixels(old, () => oldDecode.promise); fireEvent.load(old); fireEvent.error(old)
  fireEvent.click(view.getByRole("button", { name: "Retry" }))
  expect(preview).not.toHaveBeenCalled()
  const retried = view.container.querySelector("img")!
  expect(retried).not.toBe(old)
  expect(retried.getAttribute("src")).toBe("/first?version=1")
  pixels(retried, () => retryDecode.promise); fireEvent.load(retried)
  view.rerender(React.createElement(RemoteContentImage, { ...props, src: "/second?version=2" }))
  const current = view.container.querySelector("img")!
  await act(async () => { oldDecode.resolve(); retryDecode.reject(new Error("old")); await oldDecode.promise; await retryDecode.promise.catch(() => {}) })
  expect(current.dataset.remoteImageState).toBe("pending")
  expect(ready).not.toHaveBeenCalled()
  const currentDecode = deferred()
  pixels(current, () => currentDecode.promise); fireEvent.load(current)
  view.unmount()
  await act(async () => { currentDecode.resolve(); await currentDecode.promise })
  expect(ready).not.toHaveBeenCalled()
})

it("lets a cached image settle after StrictMode reattachment but rejects callbacks from its retired generation", async () => {
  const pending: ReturnType<typeof deferred>[] = []
  const decoderDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode")
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(320)
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(200)
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: () => { const next = deferred(); pending.push(next); return next.promise } })
  try {
    const view = render(React.createElement(React.StrictMode, null, React.createElement(Owner)))
    const image = view.container.querySelector("img")!
    expect(pending.length).toBeGreaterThan(1)
    await act(async () => { pending[0].resolve(); await pending[0].promise })
    expect(image.dataset.state).toBe("pending")
    await act(async () => { for (const next of pending.slice(1)) next.resolve(); await Promise.all(pending.slice(1).map(next => next.promise)) })
    expect(image.dataset.state).toBe("ready")
  } finally {
    if (decoderDescriptor) Object.defineProperty(HTMLImageElement.prototype, "decode", decoderDescriptor)
    else delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode
  }
})

it("rejects a queued timeout from StrictMode's retired generation", async () => {
  vi.useFakeTimers()
  const timers = vi.spyOn(globalThis, "setTimeout")
  const view = render(React.createElement(React.StrictMode, null, React.createElement(Owner)))
  const image = view.container.querySelector("img")!
  const retiredTimeout = timers.mock.calls.find(([, delay]) => delay === 50)![0] as () => void
  act(() => retiredTimeout())
  expect(image.dataset.state).toBe("pending")
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(image.dataset.state).toBe("error")
})
