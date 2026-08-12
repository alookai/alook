import { describe, it, expect } from "vitest"
import {
  appendGeneratedThumbnail,
  buildAttachmentUploadFormData,
  zipUploadResultsWithDimensions,
} from "./uploads"
import type { UploadFileResult } from "./uploads"

// The zip must happen BEFORE filtering out failed uploads (`null` results),
// or indices between `results` and the original `attachments` input array
// misalign once a failed upload is dropped — see the design note in
// plans/attachment-image-dimensions.md ("Exact zip transform").
describe("zipUploadResultsWithDimensions", () => {
  const upload = (name: string): UploadFileResult => ({
    url: `/media/${name}`,
    filename: name,
    contentType: "image/png",
    size: 100,
  })

  it("zips each successful result with its input's width/height, in order", () => {
    const attachments = [
      { file: new File(["a"], "a.png"), width: 100, height: 200 },
      { file: new File(["b"], "b.png"), width: 300, height: 400 },
    ]
    const results = [upload("a.png"), upload("b.png")]

    expect(zipUploadResultsWithDimensions(results, attachments)).toEqual([
      { ...upload("a.png"), width: 100, height: 200 },
      { ...upload("b.png"), width: 300, height: 400 },
    ])
  })

  it("drops a failed upload (null result) without misaligning the remaining zips", () => {
    const attachments = [
      { file: new File(["a"], "a.png"), width: 100, height: 200 },
      { file: new File(["b"], "b.png"), width: 300, height: 400 },
      { file: new File(["c"], "c.png"), width: 500, height: 600 },
    ]
    // Middle upload failed — results[1] is null, but results[0]/[2] must
    // still zip with attachments[0]/[2], not shift down by one.
    const results = [upload("a.png"), null, upload("c.png")]

    expect(zipUploadResultsWithDimensions(results, attachments)).toEqual([
      { ...upload("a.png"), width: 100, height: 200 },
      { ...upload("c.png"), width: 500, height: 600 },
    ])
  })

  it("carries width/height through as undefined for a non-image attachment", () => {
    const attachments = [{ file: new File(["a"], "a.txt") }]
    const results = [upload("a.txt")]

    expect(zipUploadResultsWithDimensions(results, attachments)).toEqual([
      { ...upload("a.txt"), width: undefined, height: undefined },
    ])
  })

  it("returns an empty array when there are no attachments", () => {
    expect(zipUploadResultsWithDimensions([], [])).toEqual([])
  })
})

describe("appendGeneratedThumbnail", () => {
  it("appends an in-cap JPEG", () => {
    const form = new FormData()
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })
    expect(appendGeneratedThumbnail(form, "image/png", blob)).toBe(true)
    expect((form.get("thumbnail") as File).type).toBe("image/jpeg")
  })

  it("degrades to original-only when the generated thumbnail exceeds 50 KiB", () => {
    const form = new FormData()
    const blob = new Blob([new Uint8Array(50 * 1024 + 1)], { type: "image/jpeg" })
    expect(appendGeneratedThumbnail(form, "image/png", blob)).toBe(false)
    expect(form.has("thumbnail")).toBe(false)
  })

  it.each(["image/avif", "image/bmp"])(
    "degrades a browser-decodable %s original to original-only",
    (contentType) => {
      const form = new FormData()
      const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })
      expect(appendGeneratedThumbnail(form, contentType, blob)).toBe(false)
      expect(form.has("thumbnail")).toBe(false)
    },
  )

  it.each([
    ["channel", { channelId: "channel_1" }],
    ["DM", { dmId: "dm_1" }],
  ])("builds %s retry multipart with the generated thumbnail", (_label, _target) => {
    const file = new File(["original"], "photo.png", { type: "image/png" })
    const thumbnailBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })
    const form = buildAttachmentUploadFormData({ file, thumbnailBlob, width: 640, height: 480 })

    expect(form.get("file")).toBe(file)
    expect(form.get("thumbnail")).toEqual(expect.objectContaining({ type: "image/jpeg", size: 4 }))
    expect(form.get("width")).toBe("640")
    expect(form.get("height")).toBe("480")
  })
})
