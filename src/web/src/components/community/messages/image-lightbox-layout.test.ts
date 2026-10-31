import { describe, expect, it } from "vitest"
import { isPointInsidePaintedImage, validImageDimensions } from "./image-lightbox-layout"

describe("image lightbox layout", () => {
  it("rejects incomplete or invalid dimensions", () => {
    expect(validImageDimensions(640, 480)).toEqual({ width: 640, height: 480 })
    expect(validImageDimensions(undefined, 480)).toBeUndefined()
    expect(validImageDimensions(0, 480)).toBeUndefined()
    expect(validImageDimensions(Number.NaN, 480)).toBeUndefined()
  })

  it("hit-tests only the painted object-contain bitmap, excluding letterbox space and honoring zoom/pan", () => {
    const frame = { left: 20, top: 60, width: 1400, height: 800 }
    const natural = { width: 800, height: 1600 }

    expect(
      isPointInsidePaintedImage({
        point: { x: 720, y: 460 },
        frame,
        natural,
        maxDimensions: natural,
        view: { scale: 1, x: 0, y: 0 },
      }),
    ).toBe(true)

    expect(
      isPointInsidePaintedImage({
        point: { x: 400, y: 460 },
        frame,
        natural,
        maxDimensions: natural,
        view: { scale: 1, x: 0, y: 0 },
      }),
    ).toBe(false)

    expect(
      isPointInsidePaintedImage({
        point: { x: 400, y: 460 },
        frame,
        natural,
        maxDimensions: natural,
        view: { scale: 2, x: 0, y: 0 },
      }),
    ).toBe(true)
  })
})
