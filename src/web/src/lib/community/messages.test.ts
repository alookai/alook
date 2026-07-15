import { describe, it, expect } from "vitest"
import { groupAttachments } from "./messages"

// `groupAttachments` derives `url` from `r2Key` via the shared
// `mediaUrlFromKey` helper — the DB row itself no longer carries a `url`
// column (plan agent-attachment-pipeline.md). `width`/`height` are optional
// on the output shape, so we assert on the actual returned object rather than
// relying on the declared type to catch a missing field.
describe("groupAttachments", () => {
  it("projects width/height onto an image-kind entry when present on the row", () => {
    const result = groupAttachments([
      { messageId: "m1", filename: "a.png", r2Key: "channel/c1/uuid/a.png", contentType: "image/png", size: 1000, width: 1920, height: 1080 },
    ])
    expect(result.m1).toEqual([
      { kind: "image", name: "a.png", url: "/api/community/media/channel/c1/uuid/a.png", width: 1920, height: 1080 },
    ])
  })

  it("leaves width/height undefined on an image-kind entry when the row has none", () => {
    const result = groupAttachments([
      { messageId: "m1", filename: "a.png", r2Key: "channel/c1/uuid/a.png", contentType: "image/png", size: 1000, width: null, height: null },
    ])
    expect(result.m1).toEqual([
      { kind: "image", name: "a.png", url: "/api/community/media/channel/c1/uuid/a.png", width: undefined, height: undefined },
    ])
  })

  it("never adds width/height to a file-kind entry, even if present on the row", () => {
    const result = groupAttachments([
      { messageId: "m1", filename: "a.pdf", r2Key: "channel/c1/uuid/a.pdf", contentType: "application/pdf", size: 2048, width: 1920, height: 1080 },
    ])
    expect(result.m1).toEqual([
      { kind: "file", name: "a.pdf", url: "/api/community/media/channel/c1/uuid/a.pdf", size: "2.0 KB" },
    ])
  })

  it("skips pending rows (messageId=null) so agent-uploaded pending attachments never surface", () => {
    const result = groupAttachments([
      { messageId: null, filename: "pending.png", r2Key: "channel/c1/uuid/pending.png", contentType: "image/png", size: 100, width: null, height: null },
      { messageId: "m1", filename: "linked.png", r2Key: "channel/c1/uuid/linked.png", contentType: "image/png", size: 100, width: null, height: null },
    ])
    expect(result).toEqual({
      m1: [{ kind: "image", name: "linked.png", url: "/api/community/media/channel/c1/uuid/linked.png", width: undefined, height: undefined }],
    })
  })
})
