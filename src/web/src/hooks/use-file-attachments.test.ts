import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { isMimeAllowed, useFileAttachments, type PendingFile } from "./use-file-attachments"

// Pin the MIME allowlist logic against the server-side `mimeAllowed` in
// `src/web/src/lib/community/upload.ts`. Both must agree — if this fires the
// client filter and the server would still reject, users see two rejections
// for one upload; if the client accepts and server rejects, users see the
// dreaded generic "file type not allowed" 400 after the round-trip.
describe("isMimeAllowed", () => {
  const ATTACHMENT_ALLOWED = [
    "image/",
    "video/",
    "audio/",
    "application/pdf",
    "text/",
  ] as const

  it("prefix entries match by prefix", () => {
    expect(isMimeAllowed("image/png", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("image/jpeg", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("video/mp4", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("audio/mpeg", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("text/plain", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("text/markdown", ATTACHMENT_ALLOWED)).toBe(true)
    expect(isMimeAllowed("text/csv", ATTACHMENT_ALLOWED)).toBe(true)
  })

  it("exact-match entries require full equality", () => {
    expect(isMimeAllowed("application/pdf", ATTACHMENT_ALLOWED)).toBe(true)
    // Not a prefix match — the entry is `application/pdf`, not `application/`.
    expect(isMimeAllowed("application/zip", ATTACHMENT_ALLOWED)).toBe(false)
    expect(isMimeAllowed("application/x-zip-compressed", ATTACHMENT_ALLOWED)).toBe(false)
    expect(isMimeAllowed("application/octet-stream", ATTACHMENT_ALLOWED)).toBe(false)
  })

  it("empty content-type is rejected", () => {
    // Browsers report `""` for files whose type can't be sniffed. Server
    // would 400 these too — align.
    expect(isMimeAllowed("", ATTACHMENT_ALLOWED)).toBe(false)
  })

  it("respects a bare exact-only list (no prefixes)", () => {
    const ICONS_ONLY = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
    expect(isMimeAllowed("image/png", ICONS_ONLY)).toBe(true)
    expect(isMimeAllowed("image/svg+xml", ICONS_ONLY)).toBe(false)
    expect(isMimeAllowed("video/mp4", ICONS_ONLY)).toBe(false)
  })
})

// `generateThumbnail` runs entirely against browser APIs unavailable under
// this repo's `environment: "node"` vitest config — mocked at the module
// boundary (this file only exercises `useFileAttachments`'s handling of the
// hook's result, not `generateThumbnail` itself, which has its own direct
// unit tests in `lib/image-thumbnail.test.ts`).
const generateThumbnailMock = vi.fn()
vi.mock("../lib/image-thumbnail", () => ({
  generateThumbnail: (...args: unknown[]) => generateThumbnailMock(...args),
}))

beforeEach(() => {
  generateThumbnailMock.mockReset()
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Renders the hook via a tiny consumer component — this repo's existing
// pattern for testing hooks without @testing-library (see
// use-messages.loading-state.test.ts).
function Capture({ onResult }: { onResult: (r: ReturnType<typeof useFileAttachments>) => void }) {
  const result = useFileAttachments()
  onResult(result)
  return null
}

async function renderCapture() {
  let latest!: ReturnType<typeof useFileAttachments>
  await act(async () => {
    TestRenderer.create(
      React.createElement(Capture, { onResult: (r) => { latest = r } }),
    )
  })
  return {
    get current() {
      return latest
    },
    async addFiles(files: File[]) {
      await act(async () => {
        await latest.addPendingFiles(files)
      })
    },
  }
}

describe("useFileAttachments — PendingFile width/height", () => {
  it("carries the image's natural width/height from generateThumbnail onto the PendingFile", async () => {
    generateThumbnailMock.mockResolvedValue({ blob: { size: 1 } as Blob, width: 1920, height: 1080 })

    const hook = await renderCapture()
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })
    await hook.addFiles([file])

    const pending: PendingFile[] = hook.current.pendingFiles
    expect(pending).toHaveLength(1)
    expect(pending[0].width).toBe(1920)
    expect(pending[0].height).toBe(1080)
  })

  it("leaves width/height undefined when generateThumbnail returns null (non-image file, or a failed decode)", async () => {
    generateThumbnailMock.mockResolvedValue(null)

    const hook = await renderCapture()
    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    await hook.addFiles([file])

    const pending: PendingFile[] = hook.current.pendingFiles
    expect(pending).toHaveLength(1)
    expect(pending[0].width).toBeUndefined()
    expect(pending[0].height).toBeUndefined()
  })
})
