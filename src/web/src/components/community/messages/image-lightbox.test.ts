import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, ...props }: { children: React.ReactNode }) => React.createElement("dialog-mock", props, children),
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("section", null, children),
}))

import { ImageLightbox } from "./image-lightbox"

function renderLightbox(image: React.ComponentProps<typeof ImageLightbox>["image"], onClose = vi.fn()) {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(ImageLightbox, { image, onClose }))
  })
  return { renderer: renderer!, onClose }
}

function imageEvent(width: number, height: number, decode: () => Promise<void>) {
  return { currentTarget: { naturalWidth: width, naturalHeight: height, decode } }
}

async function loadThumbnail(renderer: TestRenderer.ReactTestRenderer, width: number, height: number) {
  await act(async () => {
    renderer.root.findByProps({ "data-testid": tid.imageLightboxThumbnail }).props.onLoad(
      imageEvent(width, height, () => Promise.resolve()),
    )
    await Promise.resolve()
  })
}

describe("ImageLightbox", () => {
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
    const frame = renderer.root.findByProps({ "data-testid": tid.imageLightbox })
    const thumbnail = renderer.root.findByProps({ "data-testid": tid.imageLightboxThumbnail })
    const original = renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal })

    expect(frame.props.style).toEqual({
      width: "min(800px, 90vw, 151.111111vh)",
      aspectRatio: "800 / 450",
    })
    expect(thumbnail.props.className).toContain("absolute inset-0 size-full")
    expect(original.props.className).toContain("absolute inset-0 size-full")
    expect(original.props.className).toContain("opacity-0")
    expect(frame.parent?.props.className).toContain("invisible")

    await loadThumbnail(renderer, 800, 450)
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightbox }).parent?.props.className).toContain("visible")

    act(() => original.props.onLoad(imageEvent(800, 450, () => decodePromise)))
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-0")

    await act(async () => {
      resolveDecode()
      await decodePromise
    })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-100")
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxThumbnail }).props.className).toContain("opacity-0")
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightbox }).props.style).toEqual({
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
    act(() => renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.onError())

    expect(renderer.root.findAllByProps({ "data-testid": tid.imageLightboxOriginal })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxThumbnail }).props.src).toBe("/thumbnail")
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxError }).findByType("span").children)
      .toEqual(["Failed to load original image"])
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxRetry }).children).toEqual(["Retry"])

    act(() => renderer.root.findByProps({ "data-testid": tid.imageLightboxRetry }).props.onClick())
    const retriedOriginal = renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal })
    expect(retriedOriginal.props.src).toBe("/original")
    expect(renderer.root.findAllByProps({ "data-testid": tid.imageLightboxError })).toHaveLength(0)

    await act(async () => {
      retriedOriginal.props.onLoad(imageEvent(640, 480, () => Promise.resolve()))
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-100")
  })

  it("commits legacy natural dimensions with the decoded reveal", async () => {
    let resolveDecode!: () => void
    const decodePromise = new Promise<void>((resolve) => { resolveDecode = resolve })
    const { renderer } = renderLightbox({
      originalUrl: "/legacy-original",
      thumbnailUrl: "/legacy-thumbnail",
      name: "legacy",
    })
    const frame = () => renderer.root.findByProps({ "data-testid": tid.imageLightbox })

    expect(frame().props.style).toEqual({ width: "min(200px, 90vw, 85vh)", aspectRatio: "1 / 1" })
    await loadThumbnail(renderer, 200, 100)
    expect(frame().props.style).toEqual({ width: "min(200px, 90vw, 170vh)", aspectRatio: "200 / 100" })

    act(() => renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.onLoad(
      imageEvent(1000, 500, () => decodePromise),
    ))
    expect(frame().props.style).toEqual({ width: "min(200px, 90vw, 170vh)", aspectRatio: "200 / 100" })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-0")

    await act(async () => {
      resolveDecode()
      await decodePromise
    })
    expect(frame().props.style).toEqual({ width: "min(1000px, 90vw, 170vh)", aspectRatio: "1000 / 500" })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-100")
  })

  it("treats a decode failure like an original load failure", async () => {
    const { renderer } = renderLightbox({
      originalUrl: "/original",
      thumbnailUrl: "/thumbnail",
      name: "photo",
    })
    await loadThumbnail(renderer, 640, 480)
    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.onLoad(
        imageEvent(640, 480, () => Promise.reject(new Error("decode failed"))),
      )
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxError })).toBeDefined()
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxThumbnail }).props.className).toContain("opacity-100")
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
    const oldOriginal = renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal })
    const oldOnLoad = oldOriginal.props.onLoad as (event: ReturnType<typeof imageEvent>) => void
    const oldOnError = oldOriginal.props.onError as () => void

    act(() => oldOnLoad(imageEvent(640, 480, () => oldDecode)))
    act(() => oldOnError())
    act(() => renderer.root.findByProps({ "data-testid": tid.imageLightboxRetry }).props.onClick())
    const retriedOriginal = renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal })

    act(() => oldOnError())
    expect(renderer.root.findAllByProps({ "data-testid": tid.imageLightboxError })).toHaveLength(0)
    expect(retriedOriginal.props.className).toContain("opacity-0")

    await act(async () => {
      resolveOldDecode()
      await oldDecode
    })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-0")

    await act(async () => {
      retriedOriginal.props.onLoad(imageEvent(640, 480, () => Promise.resolve()))
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-100")
  })

  it("shows an explicit original-loading fallback when no thumbnail exists", () => {
    const { renderer } = renderLightbox({ originalUrl: "/original", name: "legacy" })
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxLoading }).children).toEqual(["Loading original image…"])
    expect(renderer.root.findByProps({ "data-testid": tid.imageLightbox }).props.style).toEqual({
      width: "min(200px, 90vw, 85vh)",
      aspectRatio: "1 / 1",
    })
  })

  it("keeps a cold preview hidden until the thumbnail decodes, then paints it before an already-decoded original", async () => {
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
      const frame = () => renderer.root.findByProps({ "data-testid": tid.imageLightbox })
      const original = renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal })

      expect(frame().parent?.props.className).toContain("invisible")
      await act(async () => {
        original.props.onLoad(imageEvent(1200, 630, () => Promise.resolve()))
        await Promise.resolve()
      })
      expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-0")

      await loadThumbnail(renderer, 512, 269)
      expect(frame().parent?.props.className).toContain("visible")
      expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxThumbnail }).props.className).toContain("opacity-100")
      expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-0")
      expect(runAnimationFrame).toBeTypeOf("function")

      act(() => runAnimationFrame!(0))
      expect(renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.className).toContain("opacity-100")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { name: "extreme landscape", width: 4000, height: 100 },
    { name: "extreme portrait", width: 100, height: 4000 },
  ])("keeps the error controls outside the clipped image frame for $name", ({ width, height }) => {
    const { renderer } = renderLightbox({ originalUrl: "/original", name: "extreme", width, height })
    act(() => renderer.root.findByProps({ "data-testid": tid.imageLightboxOriginal }).props.onError())
    const frame = renderer.root.findByProps({ "data-testid": tid.imageLightbox })
    const error = renderer.root.findByProps({ "data-testid": tid.imageLightboxError })
    const retry = renderer.root.findByProps({ "data-testid": tid.imageLightboxRetry })

    expect(frame.findAllByProps({ "data-testid": tid.imageLightboxError })).toHaveLength(0)
    expect(error.parent).toBe(frame.parent)
    expect(error.props.className).toContain("w-max")
    expect(retry.props.className).toContain("h-12")
    expect(retry.props.className).toContain("min-w-12")
  })

  it("preserves the dialog close callback", () => {
    const { renderer, onClose } = renderLightbox({ originalUrl: "/original", name: "photo" })
    const dialog = renderer.root.findByType("dialog-mock")
    act(() => dialog.props.onOpenChange(true))
    expect(onClose).not.toHaveBeenCalled()
    act(() => dialog.props.onOpenChange(false))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
