import { describe, it, expect } from "vitest"
import { toAttachmentVm } from "./messages"

// `toAttachmentVm` materializes the optimistic-send attachment view model
// from the uploaded-attachment shape. Its image branch must carry
// width/height through — this is one of the silent-drop sites flagged in
// plans/attachment-image-dimensions.md's plan review (an object literal
// omitting an optional field produces no typecheck error).
describe("toAttachmentVm", () => {
  it("carries width/height through on an image attachment", () => {
    const result = toAttachmentVm({
      url: "/media/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 1000,
      width: 1920,
      height: 1080,
    })
    expect(result).toEqual({ kind: "image", name: "a.png", url: "/media/a.png", width: 1920, height: 1080 })
  })

  it("leaves width/height undefined for an image attachment with no dimensions on file", () => {
    const result = toAttachmentVm({
      url: "/media/a.png",
      filename: "a.png",
      contentType: "image/png",
      size: 1000,
    })
    expect(result).toEqual({ kind: "image", name: "a.png", url: "/media/a.png", width: undefined, height: undefined })
  })

  it("never adds width/height to a file-kind attachment", () => {
    const result = toAttachmentVm({
      url: "/media/a.pdf",
      filename: "a.pdf",
      contentType: "application/pdf",
      size: 2048,
    })
    expect(result).toEqual({ kind: "file", name: "a.pdf", url: "/media/a.pdf", size: "2 KB" })
  })
})
