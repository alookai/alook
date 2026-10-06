import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

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
