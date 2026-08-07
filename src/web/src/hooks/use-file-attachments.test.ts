import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useFileAttachments, type PendingFile } from "./use-file-attachments"

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

  it("transfers accepted files without revoking their preview URLs", async () => {
    generateThumbnailMock.mockResolvedValue({ blob: { size: 1 } as Blob, width: 640, height: 480 })
    const hook = await renderCapture()
    const file = new File([new Uint8Array([1])], "photo.png", { type: "image/png" })
    await hook.addFiles([file])

    let transferred: PendingFile[] = []
    await act(async () => {
      transferred = hook.current.transferPendingFiles()
    })

    expect(transferred).toEqual([
      expect.objectContaining({ file, thumbnailUrl: "blob:fake", width: 640, height: 480 }),
    ])
    expect(hook.current.pendingFiles).toEqual([])
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })
})
