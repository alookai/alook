import { describe, it, expect } from "vitest"
import { clipboardFiles, pendingFilesToSendAttachments, popoverStyle } from "./composer"
import type { PendingFile } from "@/hooks/use-file-attachments"

// Minimal DataTransferItemList stand-in: each entry declares its `kind` and the
// File its `getAsFile()` yields (null models the browser returning nothing for
// a "file" item). Indexed access + `.length` is all `clipboardFiles` touches.
function itemList(entries: Array<{ kind: string; file: File | null }>): DataTransferItemList {
  const items = entries.map((e) => ({ kind: e.kind, getAsFile: () => e.file })) as unknown as DataTransferItem[]
  const list = { length: items.length } as unknown as DataTransferItemList
  items.forEach((it, i) => { (list as unknown as Record<number, DataTransferItem>)[i] = it })
  return list
}

function rectAt(top: number, opts: { left?: number; height?: number } = {}): DOMRect {
  const height = opts.height ?? 16
  const left = opts.left ?? 40
  return {
    top,
    bottom: top + height,
    left,
    right: left + 4,
    width: 4,
    height,
    x: left,
    y: top,
    toJSON() {},
  }
}

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

describe("popoverStyle", () => {
  const VW = 1024
  const VH = 768

  it("anchors above the caret (default) when there's room above", () => {
    const s = popoverStyle(rectAt(500), VW, VH)
    expect(s.transform).toBe("translateY(-100%)")
    expect(s.top).toBe(500 - 4)
  })

  it("flips below the caret when space above is insufficient (caret near viewport top)", () => {
    const s = popoverStyle(rectAt(100, { height: 16 }), VW, VH)
    // 100px above < 240+8, and below has room → flip
    expect(s.transform).toBeUndefined()
    expect(s.top).toBe(116 + 4) // rect.bottom + 4
  })

  it("stays above when neither side fully fits, rather than flipping into a worse spot", () => {
    // Short viewport: no room above (top=100) and no room below either.
    const s = popoverStyle(rectAt(100, { height: 16 }), VW, 200)
    // below would overflow (116+240+8 > 200) → keep the above default
    expect(s.transform).toBe("translateY(-100%)")
  })

  it("clamps left so the 256px popup never runs off the right edge", () => {
    const s = popoverStyle(rectAt(500, { left: 1000 }), VW, VH)
    // maxLeft = 1024 - 256 - 8 = 760
    expect(s.left).toBe(760)
  })

  it("keeps the caret's left when it's within bounds", () => {
    const s = popoverStyle(rectAt(500, { left: 40 }), VW, VH)
    expect(s.left).toBe(40)
  })
})
