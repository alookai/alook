import { describe, expect, it } from "vitest"
import {
  fallbackPreviewSize,
  fitImageToViewport,
  previewFrameStyle,
  validImageDimensions,
} from "./image-lightbox-layout"

describe("image lightbox layout", () => {
  it.each([
    { name: "landscape within bounds", image: { width: 800, height: 450 }, expected: { width: 800, height: 450 } },
    { name: "portrait within bounds", image: { width: 396, height: 702 }, expected: { width: 396, height: 702 } },
    { name: "small image is not enlarged", image: { width: 80, height: 40 }, expected: { width: 80, height: 40 } },
    { name: "width cap", image: { width: 2000, height: 1000 }, expected: { width: 900, height: 450 } },
    { name: "height cap", image: { width: 1000, height: 2000 }, expected: { width: 382.5, height: 765 } },
  ])("fits $name", ({ image, expected }) => {
    expect(fitImageToViewport(image, { width: 1000, height: 900 })).toEqual(expected)
  })

  it("uses a capped square fallback while legacy dimensions are unknown", () => {
    expect(fallbackPreviewSize({ width: 390, height: 844 })).toEqual({ width: 200, height: 200 })
    expect(fallbackPreviewSize({ width: 120, height: 100 })).toEqual({ width: 85, height: 85 })
  })

  it("uses live viewport CSS without upscaling or a JavaScript viewport snapshot", () => {
    expect(previewFrameStyle({ width: 1200, height: 630 })).toEqual({
      width: "min(1200px, 90vw, 161.904762vh)",
      aspectRatio: "1200 / 630",
    })
    expect(previewFrameStyle({ width: 80, height: 40 })).toEqual({
      width: "min(80px, 90vw, 170vh)",
      aspectRatio: "80 / 40",
    })
    expect(previewFrameStyle()).toEqual({
      width: "min(200px, 90vw, 85vh)",
      aspectRatio: "1 / 1",
    })
  })

  it("rejects incomplete or invalid dimensions", () => {
    expect(validImageDimensions(640, 480)).toEqual({ width: 640, height: 480 })
    expect(validImageDimensions(undefined, 480)).toBeUndefined()
    expect(validImageDimensions(0, 480)).toBeUndefined()
    expect(validImageDimensions(Number.NaN, 480)).toBeUndefined()
  })
})
