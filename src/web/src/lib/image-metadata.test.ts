import { afterEach, describe, expect, it, vi } from "vitest"
import { readCommunityImageDimensions } from "./image-metadata"

describe("local image metadata", () => {
  afterEach(() => vi.unstubAllGlobals())
  function browser(fail = false, pending = false) {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { createObjectURL: () => "blob:local", revokeObjectURL })
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      naturalWidth = 2400; naturalHeight = 1600
      set src(value: string) { if (!pending && value) queueMicrotask(() => fail ? this.onerror?.() : this.onload?.()) }
    })
    return revokeObjectURL
  }
  it("reads dimensions without re-encoding the original", async () => {
    const revoke = browser()
    const file = new File(["unchanged"], "photo.png", { type: "image/png" })
    expect(await readCommunityImageDimensions(file)).toEqual({ width: 2400, height: 1600 })
    expect(await file.text()).toBe("unchanged")
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:local")
  })
  it("leaves decode failure to the server's image preview instead of rejecting the original upload", async () => {
    const revoke = browser(true)
    expect(await readCommunityImageDimensions(new File(["bad"], "bad.png", { type: "image/png" }))).toBeNull()
    expect(revoke).toHaveBeenCalledOnce()
  })
  it("releases the local URL when pending decoding is cancelled", async () => {
    const revoke = browser(false, true)
    const controller = new AbortController()
    const pending = readCommunityImageDimensions(new File(["image"], "photo.png", { type: "image/png" }), controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort(); await rejected
    expect(revoke).toHaveBeenCalledOnce()
  })
  it("does not decode non-inline formats", async () => {
    expect(await readCommunityImageDimensions(new File(["svg"], "vector.svg", { type: "image/svg+xml" }))).toBeNull()
  })
})
