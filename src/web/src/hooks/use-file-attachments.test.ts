import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useFileAttachments, type PendingFile } from "./use-file-attachments"
import {
  readComposerAttachmentSession,
  resetComposerAttachmentSessionsForTest,
} from "../lib/community/composer-attachment-session"

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
  resetComposerAttachmentSessionsForTest()
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
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
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
    async rerender(nextOptions?: Parameters<typeof useFileAttachments>[0]) {
      await act(async () => {
        renderer.update(
          React.createElement(Capture, { onResult: (r) => { latest = r }, options: nextOptions }),
        )
      })
    },
    unmount() {
      act(() => renderer.unmount())
    },
  }
}

async function dropFiles(
  hook: Awaited<ReturnType<typeof renderCapture>>,
  files: File[],
) {
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  act(() => {
    hook.current.handleDrop({
      preventDefault,
      stopPropagation,
      dataTransfer: { files },
    } as unknown as React.DragEvent)
  })
  await act(async () => {
    await hook.current.awaitPendingFiles()
  })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(stopPropagation).toHaveBeenCalledOnce()
}

describe("useFileAttachments — DOM drop ownership", () => {
  it("routes picker selection and DOM drop through the same pending-file lifecycle", async () => {
    generateThumbnailMock.mockResolvedValue(null)
    const hook = await renderCapture()
    const selected = new File(["picker"], "picker.txt", { type: "text/plain" })
    const dropped = new File(["drop"], "drop.png", { type: "image/png" })
    const target = { files: [selected], value: "picker.txt" }

    act(() => {
      hook.current.handleFileSelect({ target } as unknown as React.ChangeEvent<HTMLInputElement>)
    })
    await act(async () => {
      await hook.current.awaitPendingFiles()
    })
    await dropFiles(hook, [dropped])

    expect(target.value).toBe("")
    expect(hook.current.pendingFiles.map(({ file }) => file)).toEqual([selected, dropped])
    expect(generateThumbnailMock).toHaveBeenCalledTimes(2)
  })

  it("keeps oversize DOM drops out of pending state and shows the existing error", async () => {
    generateThumbnailMock.mockResolvedValue(null)
    const hook = await renderCapture({ maxFileSize: 1024 * 1024 })
    const dropped = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      "too-large.png",
      { type: "image/png" },
    )

    await dropFiles(hook, [dropped])

    expect(hook.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith('"too-large.png" exceeds 1 MB limit')
    expect(generateThumbnailMock).not.toHaveBeenCalled()
  })

  it("keeps over-count DOM drops out of pending state and shows the existing error", async () => {
    generateThumbnailMock.mockResolvedValue(null)
    const hook = await renderCapture({ maxFiles: 1 })
    const files = [
      new File(["a"], "a.txt", { type: "text/plain" }),
      new File(["b"], "b.txt", { type: "text/plain" }),
    ]

    await dropFiles(hook, files)

    expect(hook.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith("You can attach up to 1 files")
    expect(generateThumbnailMock).not.toHaveBeenCalled()
  })

  it("removes a DOM-dropped Community image when preparation fails visibly", async () => {
    prepareCommunityImageMock.mockRejectedValue(new Error("decode failed"))
    const hook = await renderCapture({
      thumbnailPolicy: "community",
      draftSessionScope: "server/channel",
    })
    const dropped = new File(["image"], "broken.png", { type: "image/png" })

    await dropFiles(hook, [dropped])

    expect(hook.current.pendingFiles).toEqual([])
    expect(readComposerAttachmentSession("server/channel")).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith('Could not prepare "broken.png" for upload')
  })
})

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
    const hook = await renderCapture({ draftSessionScope: "server/channel" })
    const file = new File([new Uint8Array([1])], "photo.png", { type: "image/png" })
    await hook.addFiles([file])
    expect(readComposerAttachmentSession("server/channel")).toEqual([
      { draftId: expect.stringMatching(/.+/), file },
    ])

    let transferred: PendingFile[] = []
    await act(async () => {
      transferred = hook.current.transferPendingFiles()
    })

    expect(transferred).toEqual([
      expect.objectContaining({ file, thumbnailUrl: "blob:fake", width: 640, height: 480 }),
    ])
    expect(hook.current.pendingFiles).toEqual([])
    expect(readComposerAttachmentSession("server/channel")).toEqual([])
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
    const hook = await renderCapture({
      thumbnailPolicy: "community",
      draftSessionScope: "server/channel",
    })
    const file = new File([new Uint8Array(1)], "photo.png", { type: "image/png" })

    await hook.addFiles([file])

    expect(hook.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith('Could not prepare "photo.png" for upload')
    expect(readComposerAttachmentSession("server/channel")).toEqual([])
  })

  it("registers raw Community Files synchronously before async image preparation", async () => {
    let release!: (value: null) => void
    prepareCommunityImageMock.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const hook = await renderCapture({
      thumbnailPolicy: "community",
      draftSessionScope: "server/channel",
    })
    const file = new File(["image"], "fast-switch.png", { type: "image/png" })

    let pending!: Promise<void>
    act(() => {
      pending = hook.current.addPendingFiles([file])
    })
    expect(readComposerAttachmentSession("server/channel")).toEqual([
      { draftId: expect.stringMatching(/.+/), file },
    ])
    expect(hook.current.pendingFiles).toEqual([])

    await act(async () => {
      release(null)
      await pending
    })
    expect(hook.current.pendingFiles).toEqual([
      expect.objectContaining({ file, draftId: expect.stringMatching(/.+/) }),
    ])
  })

  it("restores by stable ID, rebuilds image URLs, and revokes only mounted previews", async () => {
    prepareCommunityImageMock.mockResolvedValue({ blob: null, width: 10, height: 20 })
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:restored")
    const hook = await renderCapture({ thumbnailPolicy: "community" })
    const file = new File(["image"], "restore.png", { type: "image/png" })
    await hook.addFiles([file])
    const draftId = hook.current.pendingFiles[0].draftId!

    await act(async () => {
      await hook.current.restorePendingFiles([{ draftId, file }])
    })

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:first")
    expect(hook.current.pendingFiles).toEqual([
      expect.objectContaining({ draftId, file, thumbnailUrl: "blob:restored" }),
    ])
    hook.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:restored")
  })

  it("keeps selected files added while restoration is queued and never duplicates IDs", async () => {
    let releaseRestore!: (value: null) => void
    prepareCommunityImageMock
      .mockReturnValueOnce(new Promise((resolve) => { releaseRestore = resolve }))
      .mockResolvedValueOnce(null)
    const hook = await renderCapture({
      thumbnailPolicy: "community",
      draftSessionScope: "server/channel",
    })
    const restored = new File(["old"], "old.txt", { type: "text/plain" })
    const selected = new File(["new"], "new.txt", { type: "text/plain" })

    let restore!: Promise<void>
    let add!: Promise<void>
    act(() => {
      restore = hook.current.restorePendingFiles([{ draftId: "old-id", file: restored }])
      add = hook.current.addPendingFiles([selected])
    })
    expect(readComposerAttachmentSession("server/channel")).toEqual([
      { draftId: expect.stringMatching(/.+/), file: selected },
    ])
    await act(async () => {
      releaseRestore(null)
      await Promise.all([restore, add])
    })
    expect(hook.current.pendingFiles.map(({ file }) => file)).toEqual([restored, selected])
    expect(new Set(hook.current.pendingFiles.map(({ draftId }) => draftId)).size).toBe(2)
  })

  it("keeps the current reservation when a stale A→B→A preparation resolves for the same ID", async () => {
    let releaseStale!: (value: null) => void
    let releaseCurrent!: (value: null) => void
    prepareCommunityImageMock
      .mockReturnValueOnce(new Promise((resolve) => { releaseStale = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { releaseCurrent = resolve }))
      .mockResolvedValue(null)
    const options = {
      thumbnailPolicy: "community" as const,
      draftSessionScope: "scope-a",
      maxFiles: 10,
    }
    const hook = await renderCapture(options)
    const restored = new File(["old"], "old.txt", { type: "text/plain" })

    let stalePreparation!: Promise<void>
    act(() => {
      stalePreparation = hook.current.addPendingFiles([restored])
    })
    const [{ draftId }] = readComposerAttachmentSession("scope-a")

    await hook.rerender({ ...options, draftSessionScope: "scope-b" })
    await hook.rerender(options)
    expect(readComposerAttachmentSession("scope-a")).toEqual([{ draftId, file: restored }])

    await act(async () => {
      releaseStale(null)
      await stalePreparation
      await Promise.resolve()
    })
    expect(prepareCommunityImageMock).toHaveBeenCalledTimes(2)

    const tenFiles = Array.from({ length: 10 }, (_, index) =>
      new File([String(index)], `${index}.txt`, { type: "text/plain" }))
    let addTen!: Promise<void>
    act(() => {
      addTen = hook.current.addPendingFiles(tenFiles)
    })
    expect(readComposerAttachmentSession("scope-a")).toEqual([{ draftId, file: restored }])
    expect(toastErrorMock).toHaveBeenCalledWith("You can attach up to 10 files")

    await act(async () => {
      releaseCurrent(null)
      await addTen
    })
    expect(hook.current.pendingFiles).toEqual([
      expect.objectContaining({ draftId, file: restored }),
    ])
  })

  it("enforces an optional Community count limit without changing the generic default", async () => {
    prepareCommunityImageMock.mockResolvedValue(null)
    generateThumbnailMock.mockResolvedValue(null)
    const files = Array.from({ length: 11 }, (_, index) =>
      new File([String(index)], `${index}.txt`, { type: "text/plain" }))
    const community = await renderCapture({ thumbnailPolicy: "community", maxFiles: 10 })
    await community.addFiles(files)
    expect(community.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith("You can attach up to 10 files")

    const generic = await renderCapture()
    await generic.addFiles(files)
    expect(generic.current.pendingFiles).toHaveLength(11)
  })
})
