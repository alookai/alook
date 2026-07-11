import { describe, it, expect } from "vitest"
import { pendingFilesToSendAttachments } from "./composer"
import type { PendingFile } from "@/hooks/use-file-attachments"

// `pendingFilesToSendAttachments` is the pure mapping Composer.send() uses
// to build onSend's attachments argument — extracted so the width/height
// threading can be unit-tested without mounting the full tiptap editor
// (Composer itself needs a real DOM; this pure function doesn't).
describe("pendingFilesToSendAttachments", () => {
  it("returns undefined for an empty pendingFiles list", () => {
    expect(pendingFilesToSendAttachments([])).toBeUndefined()
  })

  it("maps each PendingFile to {file, width, height}, preserving width/height when present", () => {
    const file = new File(["x"], "photo.png", { type: "image/png" })
    const pending: PendingFile[] = [
      { file, thumbnailUrl: null, thumbnailBlob: null, width: 1920, height: 1080 },
    ]
    const result = pendingFilesToSendAttachments(pending)
    expect(result).toEqual([{ file, width: 1920, height: 1080 }])
  })

  it("carries width/height through as undefined for a non-image PendingFile", () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" })
    const pending: PendingFile[] = [
      { file, thumbnailUrl: null, thumbnailBlob: null },
    ]
    const result = pendingFilesToSendAttachments(pending)
    expect(result).toEqual([{ file, width: undefined, height: undefined }])
  })

  it("preserves per-file order and dimensions across multiple files", () => {
    const a = new File(["a"], "a.png", { type: "image/png" })
    const b = new File(["b"], "b.png", { type: "image/png" })
    const pending: PendingFile[] = [
      { file: a, thumbnailUrl: null, thumbnailBlob: null, width: 100, height: 200 },
      { file: b, thumbnailUrl: null, thumbnailBlob: null, width: 300, height: 400 },
    ]
    const result = pendingFilesToSendAttachments(pending)
    expect(result).toEqual([
      { file: a, width: 100, height: 200 },
      { file: b, width: 300, height: 400 },
    ])
  })
})
