import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render, mockElementGeometry, type RenderResult } from "@/test/react-dom-harness"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, onOpenChange }: {
    children: React.ReactNode
    onOpenChange: (open: boolean) => void
  }) => React.createElement("div", { "data-testid": "dialog-mock" },
    React.createElement("button", {
      "data-dialog-open-change": "true",
      onClick: () => onOpenChange(true),
    }),
    React.createElement("button", {
      "data-dialog-open-change": "false",
      onClick: () => onOpenChange(false),
    }),
    children,
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("section", null, children),
}))

import { ImageLightbox } from "./image-lightbox"
import { previewFrameStyle } from "./image-lightbox-layout"

function renderLightbox(image: React.ComponentProps<typeof ImageLightbox>["image"], onClose = vi.fn()) {
  return { renderer: render(React.createElement(ImageLightbox, { image, onClose })), onClose }
}

function image(renderer: RenderResult, testId: string): HTMLImageElement {
  return renderer.container.querySelector<HTMLImageElement>(`[data-testid="${testId}"]`)!
}

function prepareImage(
  element: HTMLImageElement,
  width: number,
  height: number,
  decode: () => Promise<void>,
) {
  Object.defineProperties(element, {
    decode: { configurable: true, value: decode },
    naturalHeight: { configurable: true, value: height },
    naturalWidth: { configurable: true, value: width },
  })
}

async function loadImage(
  element: HTMLImageElement,
  width: number,
  height: number,
  decode: () => Promise<void>,
) {
  prepareImage(element, width, height, decode)
  fireEvent.load(element)
  await act(async () => {
    await Promise.resolve()
  })
}

async function loadThumbnail(renderer: RenderResult, width: number, height: number) {
  await loadImage(image(renderer, tid.imageLightboxThumbnail), width, height, () => Promise.resolve())
}

describe("ImageLightbox", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("reserves the known frame and reveals the original only after decode", async () => {
    let resolveDecode!: () => void
    const decodePromise = new Promise<void>((resolve) => { resolveDecode = resolve })
    const { renderer } = renderLightbox({
      originalUrl: "/original",
      thumbnailUrl: "/thumbnail",
      name: "photo",
      width: 800,
      height: 450,
    })
    const frame = renderer.getByTestId(tid.imageLightbox)
    const thumbnail = image(renderer, tid.imageLightboxThumbnail)
    const original = image(renderer, tid.imageLightboxOriginal)

    expect(previewFrameStyle({ width: 800, height: 450 })).toEqual({
      width: "min(800px, 90vw, 151.111111vh, calc(max(1px, calc(100vh - 144px)) * 1.777778))",
      aspectRatio: "800 / 450",
    })
    expect(frame.style.aspectRatio).toBe("800 / 450")
    expect(frame).toHaveAttribute("data-native-context-menu", "true")
    expect(thumbnail).toHaveClass("absolute", "inset-0", "size-full")
    expect(thumbnail).toHaveClass("pointer-events-none")
    expect(original).toHaveClass(
      "absolute",
      "inset-0",
      "size-full",
      "pointer-events-none",
      "opacity-0",
    )
    expect(frame.parentElement).not.toHaveClass("invisible")
    expect(renderer.getByTestId(tid.imageLightboxLoading))
      .toHaveTextContent("Loading original image")

    await loadThumbnail(renderer, 800, 450)
    expect(renderer.getByTestId(tid.imageLightbox).parentElement).not.toHaveClass("invisible")
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass("pointer-events-auto")

    prepareImage(original, 800, 450, () => decodePromise)
    fireEvent.load(original)
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-0")

    await act(async () => {
      resolveDecode()
      await decodePromise
    })
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass(
      "pointer-events-auto",
      "opacity-100",
    )
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass(
      "pointer-events-none",
      "opacity-0",
    )
    expect(previewFrameStyle({ width: 800, height: 450 })).toEqual({
      width: "min(800px, 90vw, 151.111111vh, calc(max(1px, calc(100vh - 144px)) * 1.777778))",
      aspectRatio: "800 / 450",
    })
  })

  it("keeps the thumbnail and retries only the failed original", async () => {
    const { renderer } = renderLightbox({
      originalUrl: "/original",
      thumbnailUrl: "/thumbnail",
      name: "photo",
      width: 640,
      height: 480,
    })
    await loadThumbnail(renderer, 640, 480)
    fireEvent.error(image(renderer, tid.imageLightboxOriginal))

    expect(renderer.queryAllByTestId(tid.imageLightboxOriginal)).toHaveLength(0)
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveAttribute("src", "/thumbnail")
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass("pointer-events-auto")
    expect(renderer.getByTestId(tid.imageLightboxError))
      .toHaveTextContent("Failed to load original image")
    expect(renderer.getByTestId(tid.imageLightboxRetry)).toHaveTextContent("Retry")

    fireEvent.click(renderer.getByTestId(tid.imageLightboxRetry))
    const retriedOriginal = image(renderer, tid.imageLightboxOriginal)
    expect(retriedOriginal).toHaveAttribute("src", "/original")
    expect(renderer.queryAllByTestId(tid.imageLightboxError)).toHaveLength(0)

    await loadImage(retriedOriginal, 640, 480, () => Promise.resolve())
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
  })

  it("keeps the safe legacy frame until the decoded original commits once", async () => {
    let resolveDecode!: () => void
    const decodePromise = new Promise<void>((resolve) => { resolveDecode = resolve })
    const { renderer } = renderLightbox({
      originalUrl: "/legacy-original",
      thumbnailUrl: "/legacy-thumbnail",
      name: "legacy",
    })
    const frame = () => renderer.getByTestId(tid.imageLightbox)

    expect(previewFrameStyle(undefined)).toEqual({ width: "min(200px, 90vw, 85vh, max(1px, calc(100vh - 144px)))", aspectRatio: "1 / 1" })
    expect(frame().style.aspectRatio).toBe("1 / 1")
    await loadThumbnail(renderer, 200, 100)
    expect(frame().style.aspectRatio).toBe("1 / 1")

    const original = image(renderer, tid.imageLightboxOriginal)
    prepareImage(original, 1000, 500, () => decodePromise)
    fireEvent.load(original)
    expect(frame().style.aspectRatio).toBe("1 / 1")
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-0")

    await act(async () => {
      resolveDecode()
      await decodePromise
    })
    expect(previewFrameStyle({ width: 1000, height: 500 })).toEqual({
      width: "min(1000px, 90vw, 170vh, calc(max(1px, calc(100vh - 144px)) * 2))",
      aspectRatio: "1000 / 500",
    })
    expect(frame().style.aspectRatio).toBe("1000 / 500")
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
  })

  it("treats a decode failure like an original load failure", async () => {
    const { renderer } = renderLightbox({
      originalUrl: "/original",
      thumbnailUrl: "/thumbnail",
      name: "photo",
    })
    await loadThumbnail(renderer, 640, 480)
    await loadImage(
      image(renderer, tid.imageLightboxOriginal),
      640,
      480,
      () => Promise.reject(new Error("decode failed")),
    )
    expect(renderer.getByTestId(tid.imageLightboxError)).toBeInTheDocument()
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass("opacity-100")
  })

  it("ignores late load, decode, and error callbacks from a retried attempt", async () => {
    let resolveOldDecode!: () => void
    const oldDecode = new Promise<void>((resolve) => { resolveOldDecode = resolve })
    const { renderer } = renderLightbox({
      originalUrl: "/original",
      thumbnailUrl: "/thumbnail",
      name: "photo",
      width: 640,
      height: 480,
    })
    await loadThumbnail(renderer, 640, 480)
    const oldOriginal = image(renderer, tid.imageLightboxOriginal)

    prepareImage(oldOriginal, 640, 480, () => oldDecode)
    fireEvent.load(oldOriginal)
    fireEvent.error(oldOriginal)
    fireEvent.click(renderer.getByTestId(tid.imageLightboxRetry))
    const retriedOriginal = image(renderer, tid.imageLightboxOriginal)

    fireEvent.error(oldOriginal)
    expect(renderer.queryAllByTestId(tid.imageLightboxError)).toHaveLength(0)
    expect(retriedOriginal).toHaveClass("opacity-0")

    await act(async () => {
      resolveOldDecode()
      await oldDecode
    })
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-0")

    await loadImage(retriedOriginal, 640, 480, () => Promise.resolve())
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
  })

  it("shows an explicit original-loading fallback when no thumbnail exists", () => {
    const { renderer } = renderLightbox({ originalUrl: "/original", name: "legacy" })
    expect(renderer.getByTestId(tid.imageLightboxLoading))
      .toHaveTextContent("Loading original image")
    expect(previewFrameStyle(undefined)).toEqual({
      width: "min(200px, 90vw, 85vh, max(1px, calc(100vh - 144px)))",
      aspectRatio: "1 / 1",
    })
    expect(renderer.getByTestId(tid.imageLightbox).style.aspectRatio).toBe("1 / 1")
  })

  it("keeps a slow original pending and displays its success beyond five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { renderer } = renderLightbox({ originalUrl: "/stalled", name: "stalled" })
    const loading = renderer.getByTestId(tid.imageLightboxLoading)
    expect(loading).toHaveClass("motion-reduce:animate-none")

    await act(async () => vi.advanceTimersByTime(30_000))
    expect(renderer.getByTestId(tid.imageLightboxLoading)).toBe(loading)
    expect(renderer.queryByTestId(tid.imageLightboxError)).not.toBeInTheDocument()
    await loadImage(image(renderer, tid.imageLightboxOriginal), 800, 600, () => Promise.resolve())
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
    expect(renderer.queryByTestId(tid.imageLightboxLoading)).not.toBeInTheDocument()
  })

  it("reveals a decoded original even when its thumbnail stays pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { renderer } = renderLightbox({ originalUrl: "/original", thumbnailUrl: "/stalled-thumbnail", name: "Photo" })
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveAttribute("data-remote-image-state", "pending")
    await loadImage(image(renderer, tid.imageLightboxOriginal), 1200, 600, () => Promise.resolve())
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveAttribute("data-remote-image-state", "pending")
    expect(renderer.queryByTestId(tid.imageLightboxLoading)).not.toBeInTheDocument()
    await loadThumbnail(renderer, 512, 256)
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass("opacity-0")
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
  })

  it("shows a cold pending frame, then paints the thumbnail before an already-decoded original", async () => {
    let runAnimationFrame: FrameRequestCallback | undefined
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      runAnimationFrame = callback
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())

    try {
      const { renderer } = renderLightbox({
        originalUrl: "/original",
        thumbnailUrl: "/cold-thumbnail",
        name: "cold",
        width: 1200,
        height: 630,
      })
      const frame = () => renderer.getByTestId(tid.imageLightbox)
      const original = image(renderer, tid.imageLightboxOriginal)

      expect(frame().parentElement).not.toHaveClass("invisible")
      expect(renderer.getByTestId(tid.imageLightboxLoading)).toBeInTheDocument()
      await loadImage(original, 1200, 630, () => Promise.resolve())
      expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-0")

      await loadThumbnail(renderer, 512, 269)
      expect(frame().parentElement).not.toHaveClass("invisible")
      expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass("opacity-100")
      expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-0")
      expect(runAnimationFrame).toBeTypeOf("function")

      act(() => runAnimationFrame!(0))
      expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { name: "extreme landscape", width: 4000, height: 100 },
    { name: "extreme portrait", width: 100, height: 4000 },
  ])("keeps the error controls outside the clipped image frame for $name", ({ width, height }) => {
    const { renderer } = renderLightbox({ originalUrl: "/original", name: "extreme", width, height })
    fireEvent.error(image(renderer, tid.imageLightboxOriginal))
    const frame = renderer.getByTestId(tid.imageLightbox)
    const error = renderer.getByTestId(tid.imageLightboxError)
    const retry = renderer.getByTestId(tid.imageLightboxRetry)

    expect(frame.querySelectorAll(`[data-testid="${tid.imageLightboxError}"]`)).toHaveLength(0)
    expect(error.parentElement).toBe(frame.parentElement)
    expect(error).toHaveClass("w-max")
    expect(retry).toHaveClass("h-12", "min-w-12")
  })

  it("preserves the dialog close callback", () => {
    const { renderer, onClose } = renderLightbox({ originalUrl: "/original", name: "photo" })
    fireEvent.click(renderer.container.querySelector('[data-dialog-open-change="true"]')!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(renderer.container.querySelector('[data-dialog-open-change="false"]')!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  async function readyPreview() {
    const result = renderLightbox({ originalUrl: "/zoom-original", thumbnailUrl: "/zoom-thumbnail", name: "detail", width: 800, height: 600 })
    const frame = result.renderer.getByTestId(tid.imageLightbox)
    mockElementGeometry(frame, { left: 100, top: 100, width: 400, height: 300, clientWidth: 400, clientHeight: 300 })
    await loadImage(image(result.renderer, tid.imageLightboxOriginal), 800, 600, () => Promise.resolve())
    return { ...result, frame, original: image(result.renderer, tid.imageLightboxOriginal) }
  }

  function pointer(frame: HTMLElement, type: string, id: number, x: number, y: number, button = 0) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button })
    Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } })
    fireEvent(frame, event)
  }

  it("zooms around the wheel pointer without moving the frame or zooming the page", async () => {
    const { frame, original, renderer } = await readyPreview()
    const frameStyle = frame.getAttribute("style")
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 400, clientY: 250, deltaY: -Math.log(2) / 0.002 })
    fireEvent(frame, wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(Number(frame.dataset.zoomScale)).toBeCloseTo(2)
    expect(original.style.transform).toBe("translate(-100px, 0px) scale(2)")
    expect(image(renderer, tid.imageLightboxThumbnail).style.transform).toBe(original.style.transform)
    expect(frame.getAttribute("style")).toBe(frameStyle)
    expect(original).toHaveAttribute("draggable", "false")
    expect(frame.style.touchAction).toBe("none")
  })

  it("clamps mouse dragging to the enlarged image and ignores a right-button drag", async () => {
    const { frame, original, renderer } = await readyPreview()
    fireEvent.doubleClick(frame, { clientX: 300, clientY: 250 })
    pointer(frame, "pointerdown", 1, 300, 250)
    pointer(frame, "pointermove", 1, 2000, 1800)
    expect(original.style.transform).toBe("translate(200px, 150px) scale(2)")
    pointer(frame, "pointerup", 1, 2000, 1800)
    fireEvent.click(renderer.getByRole("button", { name: "Fit image" }))
    pointer(frame, "pointerdown", 2, 300, 250, 2)
    pointer(frame, "pointermove", 2, 500, 400, 2)
    expect(original.style.transform).toBe("translate(0px, 0px) scale(1)")
  })

  it("pinches with two pointers, continues panning with one, and stops on cancellation", async () => {
    const { frame, original } = await readyPreview()
    pointer(frame, "pointerdown", 1, 250, 250)
    pointer(frame, "pointerdown", 2, 350, 250)
    pointer(frame, "pointermove", 1, 200, 250)
    pointer(frame, "pointermove", 2, 400, 250)
    expect(Number(frame.dataset.zoomScale)).toBeCloseTo(2)
    expect(original.style.transform).toBe("translate(0px, 0px) scale(2)")
    pointer(frame, "pointerup", 1, 200, 250)
    pointer(frame, "pointermove", 2, 450, 280)
    expect(original.style.transform).toBe("translate(50px, 30px) scale(2)")
    pointer(frame, "pointercancel", 2, 450, 280)
    pointer(frame, "pointermove", 2, 2000, 2000)
    expect(original.style.transform).toBe("translate(50px, 30px) scale(2)")
  })

  it("bounds wheel and trackpad zoom and keeps fit and close accessible", async () => {
    const { frame, renderer, onClose } = await readyPreview()
    fireEvent.wheel(frame, { cancelable: true, deltaY: -100000, ctrlKey: true })
    expect(frame.dataset.zoomScale).toBe("8")
    expect(renderer.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    expect(renderer.getByRole("button", { name: "Zoom out" })).toBeEnabled()
    fireEvent.click(renderer.getByRole("button", { name: "Fit image" }))
    expect(frame.dataset.zoomScale).toBe("1")
    expect(renderer.getByRole("button", { name: "Zoom out" })).toBeDisabled()
    fireEvent.click(renderer.getByRole("button", { name: "Zoom in" }))
    expect(frame.dataset.zoomScale).toBe("1.5")
    fireEvent.click(renderer.getByRole("button", { name: "Zoom out" }))
    expect(frame.dataset.zoomScale).toBe("1")
    fireEvent.click(renderer.getByRole("button", { name: "Close image preview" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("supports keyboard zoom and pan, double-click reset, and a fresh view for a new image", async () => {
    const { frame, original, renderer } = await readyPreview()
    fireEvent.keyDown(frame, { key: "+" })
    fireEvent.keyDown(frame, { key: "ArrowRight" })
    expect(original.style.transform).toBe("translate(-40px, 0px) scale(1.5)")
    fireEvent.doubleClick(frame)
    expect(frame.dataset.zoomScale).toBe("1")
    fireEvent.keyDown(frame, { key: "+" })
    fireEvent.keyDown(frame, { key: "0" })
    expect(frame.dataset.zoomScale).toBe("1")
    fireEvent.keyDown(frame, { key: "+" })
    renderer.rerender(React.createElement(ImageLightbox, { image: { originalUrl: "/next-original", name: "next", width: 800, height: 600 }, onClose: vi.fn() }))
    expect(renderer.getByTestId(tid.imageLightbox).dataset.zoomScale).toBe("1")
  })

  it("does not intercept wheel or enable zoom until the original is decoded", async () => {
    const { renderer } = renderLightbox({ originalUrl: "/pending-original", name: "pending" })
    const frame = renderer.getByTestId(tid.imageLightbox)
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 })
    fireEvent(frame, wheel)
    expect(wheel.defaultPrevented).toBe(false)
    expect(renderer.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    expect(renderer.getByRole("button", { name: "Close image preview" })).toBeEnabled()
    fireEvent.error(image(renderer, tid.imageLightboxOriginal))
    expect(renderer.getByRole("button", { name: "Zoom in" })).toBeDisabled()
    expect(renderer.getByTestId(tid.imageLightboxRetry)).toBeVisible()
  })


  it("reclamps a panned image on resize, cancels its drag, and disconnects on close", async () => {
    let resize!: ResizeObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback }
      observe = vi.fn()
      disconnect = disconnect
    })
    const { frame, original, renderer } = await readyPreview()
    fireEvent.doubleClick(frame, { clientX: 300, clientY: 250 })
    pointer(frame, "pointerdown", 1, 300, 250)
    pointer(frame, "pointermove", 1, 1000, 1000)
    mockElementGeometry(frame, { left: 100, top: 100, width: 200, height: 150 })
    act(() => resize([], {} as ResizeObserver))
    expect(original.style.transform).toBe("translate(100px, 75px) scale(2)")
    pointer(frame, "pointermove", 1, 1200, 1200)
    expect(original.style.transform).toBe("translate(100px, 75px) scale(2)")
    renderer.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 })
    fireEvent(frame, wheel)
    expect(wheel.defaultPrevented).toBe(false)
  })

})
