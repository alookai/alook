import { describe, it, expect } from "vitest"
import { buildAttachmentUploadFormData, zipUploadResultsWithDimensions } from "@/lib/community/attachment-upload"
import type { UploadFileResult } from "@/lib/community/attachment-upload"

// The zip must happen BEFORE filtering out failed uploads (`null` results),
// or indices between `results` and the original `attachments` input array
// misalign once a failed upload is dropped.
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

describe("original-only upload multipart", () => {
  it("retains the original File and advisory dimensions without a thumbnail field", async () => {
    const file = new File(["original"], "photo.png", { type: "image/png" })
    const form = buildAttachmentUploadFormData({ file, width: 640, height: 480 })
    expect(form.get("file")).toBe(file)
    expect(await (form.get("file") as File).text()).toBe("original")
    expect([...form.keys()]).toEqual(["file", "width", "height"])
    expect(form.get("width")).toBe("640")
    expect(form.get("height")).toBe("480")
  })
})
