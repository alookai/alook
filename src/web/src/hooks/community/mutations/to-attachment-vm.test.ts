import { describe, it, expect } from "vitest"
import { toAttachmentVm } from "./messages"

// `toAttachmentVm` materializes the optimistic-send attachment view model from
// the uploaded-attachment shape. Reserve-by-id (route/disc step 2b): the input
// carries the pending-row `id` (no server url), and the display url is derived
// CLIENT-side from (channelId, id) — matching the id-addressed
// `channels/{id}/attachments/{attachmentId}` door the server read path emits.
// The image branch must carry width/height through — a silent-drop site flagged
// in plans/attachment-image-dimensions.md's plan review.
describe("toAttachmentVm", () => {
  it("derives the canonical thumbnail URL only from server confirmation", () => {
    expect(toAttachmentVm("c1", {
      id: "att_1", filename: "a.png", contentType: "image/png", size: 1000, hasThumbnail: true,
    })).toMatchObject({
      thumbnailUrl: "/api/community/channels/c1/attachments/att_1/thumbnail",
    })
    expect(toAttachmentVm("c1", {
      id: "att_1", filename: "a.png", contentType: "image/png", size: 1000, hasThumbnail: false,
    })).not.toHaveProperty("thumbnailUrl")
    expect(toAttachmentVm("c1", {
      id: "att_1", filename: "a.png", contentType: "image/png", size: 1000,
    })).not.toHaveProperty("thumbnailUrl")
  })

  it("carries width/height through on an image attachment + derives the id-addressed url", () => {
    const result = toAttachmentVm("c1", {
      id: "att_1",
      filename: "a.png",
      contentType: "image/png",
      size: 1000,
      width: 1920,
      height: 1080,
    })
    expect(result).toEqual({
      kind: "image",
      name: "a.png",
      url: "/api/community/channels/c1/attachments/att_1",
      contentType: "image/png",
      sizeBytes: 1000,
      width: 1920,
      height: 1080,
    })
  })

  it("leaves width/height undefined for an image attachment with no dimensions on file", () => {
    const result = toAttachmentVm("c1", {
      id: "att_1",
      filename: "a.png",
      contentType: "image/png",
      size: 1000,
    })
    expect(result).toEqual({
      kind: "image",
      name: "a.png",
      url: "/api/community/channels/c1/attachments/att_1",
      contentType: "image/png",
      sizeBytes: 1000,
      width: undefined,
      height: undefined,
    })
  })

  it("never adds width/height to a file-kind attachment", () => {
    const result = toAttachmentVm("c1", {
      id: "att_2",
      filename: "a.pdf",
      contentType: "application/pdf",
      size: 2048,
    })
    expect(result).toEqual({
      kind: "file",
      name: "a.pdf",
      url: "/api/community/channels/c1/attachments/att_2",
      contentType: "application/pdf",
      sizeBytes: 2048,
      size: "2.0 KB",
    })
  })

  it.each(["image/svg+xml", "image/x-forged"])(
    "materializes unsafe %s attachments as file-kind",
    (contentType) => {
      const result = toAttachmentVm("c1", {
        id: "att_3",
        filename: "unsafe.img",
        contentType,
        size: 2048,
        width: 1920,
        height: 1080,
      })
      expect(result).toEqual({ kind: "file", name: "unsafe.img", url: "/api/community/channels/c1/attachments/att_3", contentType, sizeBytes: 2048, size: "2.0 KB" })
    },
  )
})
