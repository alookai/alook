import { describe, expect, it } from "vitest"
import {
  fitImageToViewport,
  validImageDimensions,
} from "./image-lightbox-layout"

describe("image lightbox layout", () => {
  it.each([
    { name: "landscape within bounds", image: { width: 800, height: 450 }, expected: { width: 800, height: 450 } },
    { name: "portrait within bounds", image: { width: 396, height: 702 }, expected: { width: 396, height: 702 } },
    { name: "small image is not enlarged", image: { width: 80, height: 40 }, expected: { width: 80, height: 40 } },
    { name: "width cap", image: { width: 2000, height: 1000 }, expected: { width: 1000, height: 500 } },
    { name: "height cap", image: { width: 1000, height: 2000 }, expected: { width: 450, height: 900 } },
    { name: "extreme landscape", image: { width: 4000, height: 100 }, expected: { width: 1000, height: 25 } },
    { name: "extreme portrait", image: { width: 100, height: 4000 }, expected: { width: 22.5, height: 900 } },
  ])("fits $name", ({ image, expected }) => {
    expect(fitImageToViewport(image, { width: 1000, height: 900 })).toEqual(expected)
  })

  it("fits within a temporarily collapsed region", () => {
    expect(fitImageToViewport({ width: 800, height: 400 }, { width: 0, height: 0 }))
      .toEqual({ width: 1, height: 0.5 })
  })

  it("uses the entire available image region in landscape orientation", () => {
    expect(fitImageToViewport({ width: 450, height: 800 }, { width: 812, height: 296 }))
      .toEqual({ width: 166.5, height: 296 })
  })

  it("rejects incomplete or invalid dimensions", () => {
    expect(validImageDimensions(640, 480)).toEqual({ width: 640, height: 480 })
    expect(validImageDimensions(undefined, 480)).toBeUndefined()
    expect(validImageDimensions(0, 480)).toBeUndefined()
    expect(validImageDimensions(Number.NaN, 480)).toBeUndefined()
  })
})
