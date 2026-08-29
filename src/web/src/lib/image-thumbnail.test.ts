import { afterEach, describe, expect, it, vi } from "vitest"
import { generateThumbnail, prepareCommunityImage } from "./image-thumbnail"

// `generateThumbnail` runs entirely against browser APIs (Image decode,
// canvas draw, URL.createObjectURL) that don't exist under this repo's
// `environment: "node"` vitest config. Stub the minimal surface it touches —
// mirrors the existing `vi.stubGlobal("window", ...)` pattern used elsewhere
// in this repo (see `inbox-filter.test.ts`) rather than pulling in jsdom.
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  private _src = ""
  get src() {
    return this._src
  }
  set src(value: string) {
    this._src = value
    queueMicrotask(() => {
      if (FakeImage.nextShouldError) {
        this.onerror?.()
      } else {
        this.naturalWidth = FakeImage.nextWidth
        this.naturalHeight = FakeImage.nextHeight
        this.onload?.()
      }
    })
  }
  static nextWidth = 0
  static nextHeight = 0
  static nextShouldError = false
}

function stubBrowserImageApis(blobSizes = [1]) {
  const canvases: Array<{ width: number; height: number }> = []
  let blobIndex = 0
  vi.stubGlobal("Image", FakeImage)
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`)
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (cb: (b: Blob | null) => void) => {
          const size = blobSizes[Math.min(blobIndex++, blobSizes.length - 1)]!
          cb(new Blob([new Uint8Array(size)], { type: "image/jpeg" }))
        },
      }
      canvases.push(canvas)
      return canvas
    },
  })
  return canvases
}

describe("generateThumbnail", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeImage.nextShouldError = false
  })

  it("returns the source image's natural width/height alongside the thumbnail blob", async () => {
    stubBrowserImageApis()
    FakeImage.nextWidth = 1920
    FakeImage.nextHeight = 1080

    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result?.width).toBe(1920)
    expect(result?.height).toBe(1080)
    expect(result?.blob).toBeTruthy()
  })

  it("returns null for a non-image file, without touching any browser API", async () => {
    // Deliberately no stubBrowserImageApis() call — if generateThumbnail's
    // early-return guard were removed, this would throw on `document` being
    // undefined rather than returning null, so this test doubles as a guard
    // against that regression.
    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    const result = await generateThumbnail(file)
    expect(result).toBeNull()
  })

  it("returns null when the image fails to decode (e.g. a corrupt file with a spoofed image MIME type)", async () => {
    stubBrowserImageApis()
    FakeImage.nextShouldError = true

    const file = new File([new Uint8Array([0, 0, 0])], "fake.png", { type: "image/png" })
    const result = await generateThumbnail(file)

    expect(result).toBeNull()
  })

  it("uses the original at the exact 1024px and 512 KiB boundaries", async () => {
    const canvases = stubBrowserImageApis()
    FakeImage.nextWidth = 1024
    FakeImage.nextHeight = 768
    const file = new File([new Uint8Array(512 * 1024)], "photo.png", { type: "image/png" })

    const result = await prepareCommunityImage(file)

    expect(result).toEqual({ blob: null, width: 1024, height: 768 })
    expect(canvases).toHaveLength(0)
  })

  it("generates a 1024px preview when dimensions exceed the edge limit", async () => {
    const canvases = stubBrowserImageApis([100])
    FakeImage.nextWidth = 1025
    FakeImage.nextHeight = 512
    const file = new File([new Uint8Array(100)], "photo.png", { type: "image/png" })

    const result = await prepareCommunityImage(file)

    expect(result?.blob?.size).toBe(100)
    expect(result).toMatchObject({ width: 1025, height: 512 })
    expect(canvases[0]).toMatchObject({ width: 1024, height: 512 })
  })

  it("generates at original dimensions when only the byte limit is exceeded", async () => {
    const canvases = stubBrowserImageApis([100])
    FakeImage.nextWidth = 640
    FakeImage.nextHeight = 480
    const file = new File([new Uint8Array(512 * 1024 + 1)], "photo.png", { type: "image/png" })

    const result = await prepareCommunityImage(file)

    expect(result?.blob?.size).toBe(100)
    expect(canvases[0]).toMatchObject({ width: 640, height: 480 })
  })

  it("reduces dimensions after exhausting bounded quality attempts", async () => {
    const oversized = new Array(7).fill(512 * 1024 + 1)
    const canvases = stubBrowserImageApis([...oversized, 256 * 1024])
    FakeImage.nextWidth = 2048
    FakeImage.nextHeight = 1024
    const file = new File([new Uint8Array(100)], "photo.png", { type: "image/png" })

    const result = await prepareCommunityImage(file)

    expect(result?.blob?.size).toBe(256 * 1024)
    expect(canvases).toHaveLength(2)
    expect(canvases[0]).toMatchObject({ width: 1024, height: 512 })
    expect(canvases[1]).toMatchObject({ width: 870, height: 435 })
  })

  it("throws when a thumbnail is required but encoding cannot satisfy the cap", async () => {
    stubBrowserImageApis([512 * 1024 + 1])
    FakeImage.nextWidth = 1025
    FakeImage.nextHeight = 512
    const file = new File([new Uint8Array(100)], "photo.png", { type: "image/png" })

    await expect(prepareCommunityImage(file)).rejects.toThrow("required image preview")
  })

  it("throws when an over-byte-limit image cannot be decoded", async () => {
    stubBrowserImageApis()
    FakeImage.nextShouldError = true
    const file = new File(
      [new Uint8Array(512 * 1024 + 1)],
      "corrupt.png",
      { type: "image/png" },
    )

    await expect(prepareCommunityImage(file)).rejects.toThrow("required image preview")
  })

  it("returns null when an under-limit image cannot be decoded", async () => {
    stubBrowserImageApis()
    FakeImage.nextShouldError = true
    const file = new File([new Uint8Array([0])], "corrupt.png", { type: "image/png" })

    await expect(prepareCommunityImage(file)).resolves.toBeNull()
  })
})
