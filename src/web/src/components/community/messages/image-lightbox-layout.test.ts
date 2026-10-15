import { describe, expect, it } from "vitest"
import { validImageDimensions } from "./image-lightbox-layout"

describe("image lightbox layout", () => {
  it("rejects incomplete or invalid dimensions", () => {
    expect(validImageDimensions(640, 480)).toEqual({ width: 640, height: 480 })
    expect(validImageDimensions(undefined, 480)).toBeUndefined()
    expect(validImageDimensions(0, 480)).toBeUndefined()
    expect(validImageDimensions(Number.NaN, 480)).toBeUndefined()
  })
})
