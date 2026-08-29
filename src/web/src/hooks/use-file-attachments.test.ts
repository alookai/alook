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
const prepareCommunityImageMock = vi.fn()
const toastErrorMock = vi.fn()
vi.mock("../lib/image-thumbnail", () => ({
  generateThumbnail: (...args: unknown[]) => generateThumbnailMock(...args),
  prepareCommunityImage: (...args: unknown[]) => prepareCommunityImageMock(...args),
}))
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastErrorMock(...args) } }))

beforeEach(() => {
  generateThumbnailMock.mockReset()
  prepareCommunityImageMock.mockReset()
  toastErrorMock.mockReset()
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Renders the hook via a tiny consumer component — this repo's existing
// pattern for testing hooks without @testing-library (see
// use-messages.loading-state.test.ts).
function Capture({
  onResult,
  options,
}: {
  onResult: (r: ReturnType<typeof useFileAttachments>) => void
  options?: Parameters<typeof useFileAttachments>[0]
}) {
  const result = useFileAttachments(options)
  onResult(result)
  return null
}

async function renderCapture(options?: Parameters<typeof useFileAttachments>[0]) {
  let latest!: ReturnType<typeof useFileAttachments>
  await act(async () => {
    TestRenderer.create(
      React.createElement(Capture, { onResult: (r) => { latest = r }, options }),
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

  it("registers preparation synchronously and returns a fresh stable snapshot", async () => {
    let resolveThumbnail!: (value: { blob: Blob; width: number; height: number }) => void
    generateThumbnailMock.mockReturnValueOnce(new Promise((resolve) => { resolveThumbnail = resolve }))
    const hook = await renderCapture()
    const file = new File(["original"], "photo.png", { type: "image/png" })
    const thumbnailBlob = new Blob(["thumbnail"], { type: "image/jpeg" })

    let addPromise!: Promise<void>
    let snapshotPromise!: Promise<readonly PendingFile[]>
    await act(async () => {
      addPromise = hook.current.addPendingFiles([file])
      snapshotPromise = hook.current.awaitPendingFiles()
      await Promise.resolve()
    })
    let settled = false
    void snapshotPromise.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await act(async () => {
      resolveThumbnail({ blob: thumbnailBlob, width: 640, height: 480 })
      await addPromise
    })
    const snapshot = await snapshotPromise
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].file).toBe(file)
    expect(snapshot[0].thumbnailBlob).toBe(thumbnailBlob)
    expect(hook.current.pendingFiles[0]).toBe(snapshot[0])
  })

  it("uses the original file as the Community preview when no thumbnail is required", async () => {
    prepareCommunityImageMock.mockResolvedValue({ blob: null, width: 1024, height: 768 })
    const hook = await renderCapture({ thumbnailPolicy: "community" })
    const file = new File([new Uint8Array(1)], "photo.png", { type: "image/png" })

    await hook.addFiles([file])

    expect(URL.createObjectURL).toHaveBeenCalledWith(file)
    expect(hook.current.pendingFiles[0]).toMatchObject({
      file,
      thumbnailUrl: "blob:fake",
      thumbnailBlob: null,
      width: 1024,
      height: 768,
    })
    expect(generateThumbnailMock).not.toHaveBeenCalled()
  })

  it("uses the generated Community JPEG for preview and upload", async () => {
    const thumbnail = new Blob([new Uint8Array(10)], { type: "image/jpeg" })
    prepareCommunityImageMock.mockResolvedValue({ blob: thumbnail, width: 2048, height: 1024 })
    const hook = await renderCapture({ thumbnailPolicy: "community" })
    const file = new File([new Uint8Array(1)], "photo.png", { type: "image/png" })

    await hook.addFiles([file])

    expect(URL.createObjectURL).toHaveBeenCalledWith(thumbnail)
    expect(hook.current.pendingFiles[0]?.thumbnailBlob).toBe(thumbnail)
  })

  it("rejects a Community image when a required preview cannot be prepared", async () => {
    prepareCommunityImageMock.mockRejectedValue(new Error("required image preview"))
    const hook = await renderCapture({ thumbnailPolicy: "community" })
    const file = new File([new Uint8Array(1)], "photo.png", { type: "image/png" })

    await hook.addFiles([file])

    expect(hook.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith('Could not prepare "photo.png" for upload')
  })
})
