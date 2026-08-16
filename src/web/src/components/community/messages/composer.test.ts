import { describe, it, expect } from "vitest"
import { clipboardFiles, pendingFilesToSendAttachments } from "./composer"
import type { ComposerProps } from "./composer"
import type { PendingFile } from "@/hooks/use-file-attachments"

describe("Composer send contract", () => {
  it("keeps accepted chat and deferred forum modes mutually exclusive", () => {
    const accepted = {
      channel: "dm",
      context: "dm" as const,
      members: [],
      sendContract: "accepted" as const,
      mode: "chat" as const,
      onAcceptSend: () => true,
    } satisfies ComposerProps
    expect(accepted.sendContract).toBe("accepted")

    // @ts-expect-error accepted sends must clear/transfer and therefore cannot use the deferred forum mode
    const invalid: ComposerProps = {
      channel: "forum",
      context: "channel",
      members: [],
      sendContract: "accepted",
      mode: "forumPostBody",
      onAcceptSend: () => true,
    }
    expect(invalid.mode).toBe("forumPostBody")
  })
})

// Minimal DataTransferItemList stand-in: each entry declares its `kind` and the
// File its `getAsFile()` yields (null models the browser returning nothing for
// a "file" item). Indexed access + `.length` is all `clipboardFiles` touches.
function itemList(entries: Array<{ kind: string; file: File | null }>): DataTransferItemList {
  const items = entries.map((e) => ({ kind: e.kind, getAsFile: () => e.file })) as unknown as DataTransferItem[]
  const list = { length: items.length } as unknown as DataTransferItemList
  items.forEach((it, i) => { (list as unknown as Record<number, DataTransferItem>)[i] = it })
  return list
}

// `pendingFilesToSendAttachments` is the pure mapping Composer.send() uses
// to build onSend's attachments argument — extracted so the width/height
// threading can be unit-tested without mounting the full tiptap editor
// (Composer itself needs a real DOM; this pure function doesn't).
describe("pendingFilesToSendAttachments", () => {
  it("returns undefined for an empty pendingFiles list", () => {
    expect(pendingFilesToSendAttachments([])).toBeUndefined()
  })

  it("preserves the exact thumbnail Blob with the file and dimensions", () => {
    const file = new File(["x"], "photo.png", { type: "image/png" })
    const thumbnailBlob = new Blob(["thumbnail"], { type: "image/jpeg" })
    const pending: PendingFile[] = [
      { file, thumbnailUrl: "blob:thumbnail", thumbnailBlob, width: 1920, height: 1080 },
    ]
    const result = pendingFilesToSendAttachments(pending)
    expect(result).toEqual([{
      file,
      thumbnailBlob,
      previewObjectUrl: "blob:thumbnail",
      width: 1920,
      height: 1080,
    }])
    expect(result?.[0].thumbnailBlob).toBe(thumbnailBlob)
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

// `clipboardFiles` is the pure filter behind `editorProps.handlePaste` — it
// picks the pasted File(s) out of the clipboard so an image paste routes to
// `addPendingFiles` (same as picker/drop). A text-only paste yields [] so the
// handler returns false and the paste falls through to `clipboardTextParser`.
describe("clipboardFiles", () => {
  const png = new File(["x"], "photo.png", { type: "image/png" })
  const jpg = new File(["y"], "shot.jpg", { type: "image/jpeg" })

  it("returns [] when there's no clipboard items list", () => {
    expect(clipboardFiles(undefined)).toEqual([])
  })

  it("returns [] for a text-only paste (no file items → falls through to text parser)", () => {
    expect(clipboardFiles(itemList([{ kind: "string", file: null }]))).toEqual([])
  })

  it("collects a single pasted image file", () => {
    expect(clipboardFiles(itemList([{ kind: "file", file: png }]))).toEqual([png])
  })

  it("collects multiple pasted files in order, ignoring interleaved string items", () => {
    const list = itemList([
      { kind: "string", file: null },
      { kind: "file", file: png },
      { kind: "file", file: jpg },
    ])
    expect(clipboardFiles(list)).toEqual([png, jpg])
  })

  it("skips a file item whose getAsFile() returns null", () => {
    const list = itemList([
      { kind: "file", file: null },
      { kind: "file", file: png },
    ])
    expect(clipboardFiles(list)).toEqual([png])
  })
})
