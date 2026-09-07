import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, render, type RenderResult } from "@/test/react-dom-harness"

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
      width: "min(800px, 90vw, 151.111111vh)",
      aspectRatio: "800 / 450",
    })
    expect(frame.style.aspectRatio).toBe("800 / 450")
    expect(thumbnail).toHaveClass("absolute", "inset-0", "size-full")
    expect(original).toHaveClass("absolute", "inset-0", "size-full", "opacity-0")
    expect(frame.parentElement).not.toHaveClass("invisible")
    expect(renderer.getByTestId(tid.imageLightboxLoading))
      .toHaveTextContent("Loading original image")

    await loadThumbnail(renderer, 800, 450)
    expect(renderer.getByTestId(tid.imageLightbox).parentElement).not.toHaveClass("invisible")

    prepareImage(original, 800, 450, () => decodePromise)
    fireEvent.load(original)
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-0")

    await act(async () => {
      resolveDecode()
      await decodePromise
    })
    expect(image(renderer, tid.imageLightboxOriginal)).toHaveClass("opacity-100")
    expect(image(renderer, tid.imageLightboxThumbnail)).toHaveClass("opacity-0")
    expect(previewFrameStyle({ width: 800, height: 450 })).toEqual({
      width: "min(800px, 90vw, 151.111111vh)",
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

    expect(previewFrameStyle(undefined)).toEqual({ width: "min(200px, 90vw, 85vh)", aspectRatio: "1 / 1" })
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
      width: "min(1000px, 90vw, 170vh)",
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
      width: "min(200px, 90vw, 85vh)",
      aspectRatio: "1 / 1",
    })
    expect(renderer.getByTestId(tid.imageLightbox).style.aspectRatio).toBe("1 / 1")
  })

  it("turns a stalled eager original into a static retryable error", async () => {
    vi.useFakeTimers()
    const { renderer } = renderLightbox({ originalUrl: "/stalled", name: "stalled" })
    const loading = renderer.getByTestId(tid.imageLightboxLoading)
    expect(loading).toHaveClass("motion-reduce:animate-none")

    await act(async () => vi.advanceTimersByTime(5_000))

    expect(renderer.queryAllByTestId(tid.imageLightboxLoading)).toHaveLength(0)
    const error = renderer.getByTestId(tid.imageLightboxError)
    expect(error.querySelector("span")).toHaveTextContent("Failed to load original image")
    expect(renderer.getByTestId(tid.imageLightboxRetry)).toHaveClass("min-w-12")
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
})
