import { describe, expect, it } from "vitest"
import { MESSAGE_PREVIEW_LENGTH } from "@alook/shared"
import { toOptimisticReplyPreview } from "./reply-preview"

describe("toOptimisticReplyPreview", () => {
  it("gives channel and DM optimistic sends the same bounded preview shape", () => {
    const reply = { id: "m1", authorName: "Alice", text: "x".repeat(MESSAGE_PREVIEW_LENGTH + 1) }
    expect(toOptimisticReplyPreview(reply)).toEqual({
      id: "m1",
      authorName: "Alice",
      text: `${"x".repeat(MESSAGE_PREVIEW_LENGTH - 1)}…`,
    })
  })

  it("uses the shared surrogate-safe boundary", () => {
    const reply = {
      id: "m1",
      authorName: "Alice",
      text: `${"x".repeat(MESSAGE_PREVIEW_LENGTH - 2)}😀tail`,
    }
    expect(toOptimisticReplyPreview(reply).text).toBe(`${"x".repeat(MESSAGE_PREVIEW_LENGTH - 2)}…`)
  })
})
