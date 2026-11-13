import { describe, expect, it } from "vitest"
import { withImageGallery } from "./image-preview-gallery"

describe("image preview gallery", () => {
  const messages = [{ id: "first", attachments: [
    { kind: "image" as const, url: "/same", name: "one" },
    { kind: "file" as const, url: "/file", name: "file", size: "1 KB" },
    { kind: "image" as const, url: "/two", name: "two" },
  ] }, { id: "second", attachments: [{ kind: "image" as const, url: "/same", name: "three" }] }]
  it("keeps message and attachment order and repeated images distinct", () => {
    const selected = withImageGallery({ key: "second:0", originalUrl: "/same", name: "three" }, messages)
    expect(selected.key).toBe("second:0")
    expect(selected.images?.map(item => item.key)).toEqual(["first:0", "first:2", "second:0"])
    expect(selected.images?.map(item => item.name)).toEqual(["one", "two", "three"])
  })
  it("preserves the original preview when outside the supplied conversation", () => {
    const selected = { key: "other:0", originalUrl: "/same", name: "other" }
    expect(withImageGallery(selected, messages)).toBe(selected)
    expect(withImageGallery(selected, [])).toBe(selected)
  })
})
