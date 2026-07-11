import { afterEach, describe, expect, it, vi } from "vitest"
import { generateThumbnail } from "./image-thumbnail"

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

function stubBrowserImageApis() {
  vi.stubGlobal("Image", FakeImage)
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  })
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toBlob: (cb: (b: Blob | null) => void) => cb({ size: 1 } as Blob),
      }
    },
  })
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
})
