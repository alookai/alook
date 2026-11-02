import source0 from "../channels/dm-view.tsx?raw"
import source1 from "../channels/thread-channel-surface.tsx?raw"
import source2 from "./attachment-card.tsx?raw"
import source3 from "./attachment-preview-sheet.tsx?raw"
import source4 from "./media-attachment-block.tsx?raw"
import source5 from "./message-channel-controller-actions.ts?raw"
import source6 from "./message-context-sheet.tsx?raw"
import source7 from "./message-share-dialog.tsx?raw"
import source8 from "./message.tsx?raw"
import source9 from "./thread-opener.tsx?raw"
import source10 from "../../remote-image/remote-markdown-image.tsx?raw"
import { describe, expect, it } from "vitest"

const sources: Record<string, string> = {
  "src/components/community/channels/dm-view.tsx": source0,
  "src/components/community/channels/thread-channel-surface.tsx": source1,
  "src/components/community/messages/attachment-card.tsx": source2,
  "src/components/community/messages/attachment-preview-sheet.tsx": source3,
  "src/components/community/messages/media-attachment-block.tsx": source4,
  "src/components/community/messages/message-channel-controller-actions.ts": source5,
  "src/components/community/messages/message-context-sheet.tsx": source6,
  "src/components/community/messages/message-share-dialog.tsx": source7,
  "src/components/community/messages/message.tsx": source8,
  "src/components/community/messages/thread-opener.tsx": source9,
  "src/components/remote-image/remote-markdown-image.tsx": source10,
}
const source = (path: string) => {
  if (!(path in sources)) throw new Error("unregistered contract source: " + path)
  return sources[path]
}

describe("Community attachment download surface contract", () => {
  it("keeps every ordinary attachment action on the shared owner", () => {
    for (const path of [
      "src/components/community/messages/attachment-card.tsx",
      "src/components/community/messages/media-attachment-block.tsx",
      "src/components/community/messages/attachment-preview-sheet.tsx",
    ]) {
      expect(source(path), path).toContain("useAttachmentDownload")
    }
  })

  it("does not restore a direct anchor fallback in DM, channel, thread, context, or preview", () => {
    for (const path of [
      "src/components/community/channels/dm-view.tsx",
      "src/components/community/channels/thread-channel-surface.tsx",
      "src/components/community/messages/message-channel-controller-actions.ts",
      "src/components/community/messages/message-context-sheet.tsx",
      "src/components/community/messages/attachment-card.tsx",
      "src/components/community/messages/media-attachment-block.tsx",
      "src/components/community/messages/attachment-preview-sheet.tsx",
    ]) {
      const text = source(path)
      expect(text, path).not.toContain("onDownloadFile")
      expect(text, path).not.toMatch(/createElement\(["']a["']\)/)
      expect(text, path).not.toMatch(/<a\b[^>]*\bdownload=/)
    }
  })

  it("routes remote images and share images through the product owner", () => {
    for (const path of [
      "src/components/remote-image/remote-markdown-image.tsx",
    ]) {
      const text = source(path)
      expect(text, path).toContain("FileDownloadButton")
      expect(text, path).not.toMatch(/<a\b[^>]*\bdownload=/)
      expect(text, path).not.toMatch(/createElement\(["']a["']\)/)
      expect(text, path).not.toContain("window.open")
    }
    const share = source("src/components/community/messages/message-share-dialog.tsx")
    expect(share).toContain("saveFile(blob, filename")
    expect(share).toContain("saveMobileShareImage")
    expect(share).not.toMatch(/createElement\(["']a["']\)/)
  })

  it("renders representative message and thread attachments without a surface callback", () => {
    for (const path of [
      "src/components/community/messages/message.tsx",
      "src/components/community/messages/thread-opener.tsx",
    ]) {
      const text = source(path)
      expect(text, path).toContain("<AttachmentCard")
      expect(text, path).not.toContain("onDownload=")
    }
  })
})
