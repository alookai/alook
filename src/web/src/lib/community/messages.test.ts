import { describe, it, expect } from "vitest"
import { groupAttachments } from "./messages"

// No test file covered `groupAttachments` before this — it was only
// exercised indirectly through route tests. `width`/`height` are optional
// fields on the output shape, which per a plan review of
// plans/attachment-image-dimensions.md means an implementation could omit
// them from the `entry` object literal (and its `as {...}` cast) with zero
// typecheck error — assert on the actual returned value, not just the
// declared type, to catch that.
describe("groupAttachments", () => {
  it("projects width/height onto an image-kind entry when present on the row", () => {
    const result = groupAttachments([
      { messageId: "m1", filename: "a.png", url: "/a.png", contentType: "image/png", size: 1000, width: 1920, height: 1080 },
    ])
    expect(result.m1).toEqual([
      { kind: "image", name: "a.png", url: "/a.png", width: 1920, height: 1080 },
    ])
  })

  it("leaves width/height undefined on an image-kind entry when the row has none", () => {
    const result = groupAttachments([
      { messageId: "m1", filename: "a.png", url: "/a.png", contentType: "image/png", size: 1000, width: null, height: null },
    ])
    expect(result.m1).toEqual([
      { kind: "image", name: "a.png", url: "/a.png", width: undefined, height: undefined },
    ])
  })

  it("never adds width/height to a file-kind entry, even if present on the row", () => {
    const result = groupAttachments([
      { messageId: "m1", filename: "a.pdf", url: "/a.pdf", contentType: "application/pdf", size: 2048, width: 1920, height: 1080 },
    ])
    expect(result.m1).toEqual([
      { kind: "file", name: "a.pdf", url: "/a.pdf", size: "2.0 KB" },
    ])
  })
})
