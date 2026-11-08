import { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React from "react"
import { act, renderHook as renderHookLeaf, render as renderLeaf, waitFor } from "@/test/react-dom-harness"
import { useFileAttachments, type PendingFile } from "./use-file-attachments"
import {
  appendComposerAttachmentSession,
  readComposerAttachmentSession,
  resetComposerAttachmentSessionsForTest,
} from "../lib/community/composer-attachment-session"

// The image decoder is tested separately; this suite owns preparation lifetimes.
const prepareCommunityImageMock = vi.fn()
const toastErrorMock = vi.fn()
vi.mock("../lib/image-thumbnail", () => ({
  prepareCommunityImage: (...args: unknown[]) => prepareCommunityImageMock(...args),
}))
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastErrorMock(...args) } }))

beforeEach(() => {
  prepareCommunityImageMock.mockReset().mockResolvedValue(null)
  toastErrorMock.mockReset()
  resetComposerAttachmentSessionsForTest()
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function NativeFiles({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => new QueryClient())
  React.useEffect(() => () => client.clear(), [client])
  return React.createElement(QueryClientProvider, { client }, children)
}
const render: typeof renderLeaf = (node, options) => renderLeaf(node, { ...options, wrapper: NativeFiles })
const renderHook: typeof renderHookLeaf = (hook, options) => renderHookLeaf(hook, { ...options, wrapper: NativeFiles })
async function renderCapture(options?: Parameters<typeof useFileAttachments>[0]) {
  const rendered = renderHook(
    ({ currentOptions }: { currentOptions?: Parameters<typeof useFileAttachments>[0] }) =>
      useFileAttachments(currentOptions),
    { initialProps: { currentOptions: options } },
  )
  return {
    get current() {
      return rendered.result.current
    },
    async addFiles(files: File[]) {
      await act(async () => {
        await rendered.result.current.addPendingFiles(files)
      })
    },
    async rerender(nextOptions?: Parameters<typeof useFileAttachments>[0]) {
      rendered.rerender({ currentOptions: nextOptions })
    },
    unmount() {
      rendered.unmount()
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
  it("ignores non-file drags and clears nested file feedback after leaving or an empty file drop", async () => {
    const hook = await renderCapture()
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none" } }
    act(() => { hook.current.handleDragEnter(event as never); hook.current.handleDragOver(event as never); hook.current.handleDrop(event as never) })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(hook.current.dragging).toBe(false)
    event.dataTransfer.types = ["Files"]
    act(() => { hook.current.handleDragEnter(event as never); hook.current.handleDragEnter(event as never); hook.current.handleDragOver(event as never) })
    expect(hook.current.dragging).toBe(true)
    expect(event.dataTransfer.dropEffect).toBe("copy")
    act(() => hook.current.handleDragLeave(event as never))
    expect(hook.current.dragging).toBe(true)
    act(() => hook.current.handleDragLeave(event as never))
    expect(hook.current.dragging).toBe(false)
    act(() => { hook.current.handleDragEnter(event as never); hook.current.handleDrop(event as never) })
    expect(hook.current.dragging).toBe(false)
    expect(hook.current.pendingFiles).toEqual([])
    expect(prepareCommunityImageMock).not.toHaveBeenCalled()
  })

  it("routes picker selection and DOM drop through the same pending-file lifecycle", async () => {
    prepareCommunityImageMock.mockResolvedValue(null)
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
    expect(prepareCommunityImageMock).toHaveBeenCalledTimes(2)
  })

  it("keeps oversize DOM drops out of pending state and shows the existing error", async () => {
    prepareCommunityImageMock.mockResolvedValue(null)
    const hook = await renderCapture(undefined)
    const dropped = new File(
      [new Uint8Array(25 * 1024 * 1024 + 1)],
      "too-large.png",
      { type: "image/png" },
    )

    await dropFiles(hook, [dropped])

    expect(hook.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith('"too-large.png" exceeds 25 MB limit')
    expect(prepareCommunityImageMock).not.toHaveBeenCalled()
  })

  it("keeps over-count DOM drops out of pending state and shows the existing error", async () => {
    prepareCommunityImageMock.mockResolvedValue(null)
    const hook = await renderCapture(undefined)
    const files = Array.from({ length: 11 }, (_, i) => new File([String(i)], `${i}.txt`, { type: "text/plain" }))

    await dropFiles(hook, files)

    expect(hook.current.pendingFiles).toEqual([])
    expect(toastErrorMock).toHaveBeenCalledWith("You can attach up to 10 files")
    expect(prepareCommunityImageMock).not.toHaveBeenCalled()
  })

  it("retains a failed DOM-dropped image until the user explicitly removes it", async () => {
    prepareCommunityImageMock.mockRejectedValue(new Error("decode failed"))
    const hook = await renderCapture("server/channel")
    const dropped = new File(["image"], "broken.png", { type: "image/png" })

    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    act(() => hook.current.handleDrop({
      preventDefault, stopPropagation, dataTransfer: { files: [dropped] },
    } as unknown as React.DragEvent))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Could not prepare "broken.png" for upload'))
    await expect(hook.current.awaitPendingFiles()).rejects.toThrow("Attachment preparation failed")
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(hook.current.pendingFiles).toEqual([expect.objectContaining({ file: dropped, preparationFailed: true })])
    expect(readComposerAttachmentSession("server/channel")).toEqual([{ draftId: hook.current.pendingFiles[0]?.draftId, file: dropped }])

    act(() => hook.current.removePendingFile(0))
    await expect(hook.current.awaitPendingFiles()).resolves.toEqual([])
    expect(readComposerAttachmentSession("server/channel")).toEqual([])
  })
})

describe("useFileAttachments — PendingFile width/height", () => {
  it("publishes ordered preparation cards immediately and settles each file before the rest of its batch", async () => {
    let finishFirst!: (value: null) => void
    let finishSecond!: (value: null) => void
    prepareCommunityImageMock
      .mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve }))
    const hook = await renderCapture(undefined)
    const files = [new File(["one"], "one.png", { type: "image/png" }), new File(["two"], "two.png", { type: "image/png" })]
    let adding!: Promise<void>
    act(() => { adding = hook.current.addPendingFiles(files) })
    expect(hook.current.pendingFiles.map(item => [item.file.name, item.preparing])).toEqual([["one.png", true], ["two.png", true]])
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledOnce())
    await act(async () => { finishFirst(null) })
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledTimes(2))
    expect(hook.current.pendingFiles[0].preparing).toBeFalsy()
    expect(hook.current.pendingFiles[1].preparing).toBe(true)
    await act(async () => { finishSecond(null); await adding })
    expect(hook.current.pendingFiles.map(item => item.file)).toEqual(files)
  })

  it("cancels a removed preparation, releases its draft/capacity, and never republishes its late result", async () => {
    let finishRemoved!: (value: { blob: Blob; width: number; height: number }) => void
    prepareCommunityImageMock
      .mockReturnValueOnce(new Promise(resolve => { finishRemoved = resolve }))
      .mockResolvedValue(null)
    const hook = await renderCapture("scope")
    const removed = new File(["one"], "removed.png", { type: "image/png" })
    const kept = new File(["two"], "kept.txt", { type: "text/plain" })
    let adding!: Promise<void>
    act(() => { adding = hook.current.addPendingFiles([removed]) })
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledOnce())
    const signal = prepareCommunityImageMock.mock.calls[0][1] as AbortSignal
    act(() => hook.current.removePendingFile(0))
    expect(signal.aborted).toBe(true)
    expect(readComposerAttachmentSession("scope")).toEqual([])
    await act(async () => { await hook.current.addPendingFiles([kept]); await adding })
    await act(async () => finishRemoved({ blob: new Blob(["old"]), width: 100, height: 100 }))
    expect(hook.current.pendingFiles.map(item => item.file)).toEqual([kept])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
    expect(readComposerAttachmentSession("scope").map(item => item.file)).toEqual([kept])
  })

  it("carries the image's natural width/height from prepareCommunityImage onto the PendingFile", async () => {
    prepareCommunityImageMock.mockResolvedValue({ blob: { size: 1 } as Blob, width: 1920, height: 1080 })

    const hook = await renderCapture()
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" })
    await hook.addFiles([file])

    const pending: PendingFile[] = hook.current.pendingFiles
    expect(pending).toHaveLength(1)
    expect(pending[0].width).toBe(1920)
    expect(pending[0].height).toBe(1080)
  })

  it("leaves width/height undefined when prepareCommunityImage returns null (non-image file, or a failed decode)", async () => {
    prepareCommunityImageMock.mockResolvedValue(null)

    const hook = await renderCapture()
    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    await hook.addFiles([file])

    const pending: PendingFile[] = hook.current.pendingFiles
    expect(pending).toHaveLength(1)
    expect(pending[0].width).toBeUndefined()
    expect(pending[0].height).toBeUndefined()
  })

  it("transfers accepted files without revoking their preview URLs", async () => {
    prepareCommunityImageMock.mockResolvedValue({ blob: { size: 1 } as Blob, width: 640, height: 480 })
    const hook = await renderCapture("server/channel")
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
    prepareCommunityImageMock.mockReturnValueOnce(new Promise((resolve) => { resolveThumbnail = resolve }))
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
    const hook = await renderCapture(undefined)
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
    expect(prepareCommunityImageMock).toHaveBeenCalledWith(file, expect.any(AbortSignal))
  })

  it("uses the generated Community JPEG for preview and upload", async () => {
    const thumbnail = new Blob([new Uint8Array(10)], { type: "image/jpeg" })
    prepareCommunityImageMock.mockResolvedValue({ blob: thumbnail, width: 2048, height: 1024 })
    const hook = await renderCapture(undefined)
    const file = new File([new Uint8Array(1)], "photo.png", { type: "image/png" })

    await hook.addFiles([file])

    expect(URL.createObjectURL).toHaveBeenCalledWith(thumbnail)
    expect(hook.current.pendingFiles[0]?.thumbnailBlob).toBe(thumbnail)
  })

  it("rejects a Community image when a required preview cannot be prepared", async () => {
    prepareCommunityImageMock.mockRejectedValue(new Error("required image preview"))
    const hook = await renderCapture("server/channel")
    const file = new File([new Uint8Array(1)], "photo.png", { type: "image/png" })

    await hook.addFiles([file])

    await expect(hook.current.awaitPendingFiles()).rejects.toThrow("Attachment preparation failed")
    expect(hook.current.pendingFiles).toEqual([expect.objectContaining({ file, preparationFailed: true, thumbnailBlob: null, thumbnailUrl: null })])
    expect(toastErrorMock).toHaveBeenCalledWith('Could not prepare "photo.png" for upload')
    expect(readComposerAttachmentSession("server/channel")).toEqual([{ draftId: hook.current.pendingFiles[0]?.draftId, file }])
  })

  it("registers raw Community Files synchronously before async image preparation", async () => {
    let release!: (value: null) => void
    prepareCommunityImageMock.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const hook = await renderCapture("server/channel")
    const file = new File(["image"], "fast-switch.png", { type: "image/png" })

    let pending!: Promise<void>
    act(() => {
      pending = hook.current.addPendingFiles([file])
    })
    expect(readComposerAttachmentSession("server/channel")).toEqual([
      { draftId: expect.stringMatching(/.+/), file },
    ])
    expect(hook.current.pendingFiles).toEqual([
      expect.objectContaining({ file, preparing: true }),
    ])

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
    const hook = await renderCapture("restore-scope")
    const file = new File(["image"], "restore.png", { type: "image/png" })
    await hook.addFiles([file])
    const draftId = hook.current.pendingFiles[0].draftId!

    await hook.rerender("other-scope")
    await hook.rerender("restore-scope")
    await act(async () => { await hook.current.awaitPendingFiles() })

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
    const restored = new File(["old"], "old.txt", { type: "text/plain" })
    const selected = new File(["new"], "new.txt", { type: "text/plain" })

    appendComposerAttachmentSession("server/channel", [{ draftId: "old-id", file: restored }])
    const hook = await renderCapture("server/channel")
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledOnce())
    let add!: Promise<void>
    act(() => {
      add = hook.current.addPendingFiles([selected])
    })
    expect(readComposerAttachmentSession("server/channel")).toEqual([
      { draftId: "old-id", file: restored },
      { draftId: expect.stringMatching(/.+/), file: selected },
    ])
    await act(async () => {
      releaseRestore(null)
      await add
      await hook.current.awaitPendingFiles()
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
    const options = "scope-a"
    const hook = await renderCapture(options)
    const restored = new File(["old"], "old.txt", { type: "text/plain" })

    let stalePreparation!: Promise<void>
    act(() => {
      stalePreparation = hook.current.addPendingFiles([restored])
    })
    const [{ draftId }] = readComposerAttachmentSession("scope-a")
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledTimes(1))

    await hook.rerender("scope-b")
    await hook.rerender(options)
    expect(readComposerAttachmentSession("scope-a")).toEqual([{ draftId, file: restored }])

    await act(async () => {
      releaseStale(null)
      await stalePreparation
      await Promise.resolve()
    })
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledTimes(2))

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
})


describe("attachment view retirement", () => {
  it.each([false, true].flatMap(scoped => [false, true].map(thumbnail => ({ scoped, thumbnail }))))("retains a prepared preview through Activity hide/show (scope=$scoped, thumbnail=$thumbnail)", async ({ scoped, thumbnail }) => {
    prepareCommunityImageMock.mockResolvedValue({ blob: thumbnail ? new Blob(["thumbnail"]) : null, width: 10, height: 10 })
    let current!: ReturnType<typeof useFileAttachments>
    function Capture() { const value = useFileAttachments(scoped ? "activity" : undefined); React.useLayoutEffect(() => { current = value }); return null }
    function App({ hidden }: { hidden: boolean }) { return React.createElement(React.Activity, { mode: hidden ? "hidden" : "visible" }, React.createElement(Capture)) }
    const mounted = render(React.createElement(App, { hidden: false }))
    const file = new File(["file"], "photo.png", { type: "image/png" })
    await act(async () => current.addPendingFiles([file]))
    expect(current.pendingFiles[0].thumbnailUrl).toBe("blob:fake")
    act(() => mounted.rerender(React.createElement(App, { hidden: true })))
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fake")
    act(() => mounted.rerender(React.createElement(App, { hidden: false })))
    await waitFor(() => expect(current.pendingFiles[0].thumbnailUrl).toBe("blob:fake"))
    expect(current.pendingFiles[0].file).toBe(file)
    expect(current.pendingFiles[0].thumbnailBlob === null).toBe(!thumbnail)
    expect(prepareCommunityImageMock).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
    if (!thumbnail) expect(URL.createObjectURL).toHaveBeenLastCalledWith(file)
    mounted.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
  it("requeues only canceled scoped drafts while retaining a completed preview after Activity resumes", async () => {
    let finishOld!: (value: unknown) => void
    prepareCommunityImageMock.mockResolvedValueOnce({ blob: new Blob(["first"]), width: 10, height: 10 })
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce({ blob: new Blob(["current"]), width: 20, height: 20 })
    let url = 0
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:activity-${++url}`)
    let current!: ReturnType<typeof useFileAttachments>
    function Capture() { const value = useFileAttachments("activity"); React.useLayoutEffect(() => { current = value }); return null }
    const node = (hidden: boolean) => React.createElement(React.Activity, { mode: hidden ? "hidden" : "visible" }, React.createElement(Capture))
    const mounted = render(node(false))
    const completed = new File(["first"], "first.png", { type: "image/png" })
    const pending = new File(["second"], "second.png", { type: "image/png" })
    await act(async () => current.addPendingFiles([completed]))
    let oldPreparation!: Promise<void>
    act(() => { oldPreparation = current.addPendingFiles([pending]) })
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledTimes(2))
    act(() => mounted.rerender(node(true)))
    await act(async () => { await oldPreparation })
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    act(() => mounted.rerender(node(false)))
    await waitFor(() => expect(current.pendingFiles.map(row => [row.file, row.thumbnailUrl])).toEqual([
      [completed, "blob:activity-2"], [pending, "blob:activity-3"],
    ]))
    expect(prepareCommunityImageMock.mock.calls.map(([file]) => file)).toEqual([completed, pending, pending])
    await act(async () => { finishOld({ blob: new Blob(["stale"]), width: 99, height: 99 }); await Promise.resolve() })
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3)
    expect(current.pendingFiles[1].width).toBe(20)
    expect(toastErrorMock).not.toHaveBeenCalled()
    mounted.unmount()
  })
  it("held preparation from a retired Activity cannot publish after reactivation", async () => {
    let finish!: (value: unknown) => void
    prepareCommunityImageMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    let current!: ReturnType<typeof useFileAttachments>
    function Capture() { const value = useFileAttachments(); React.useLayoutEffect(() => { current = value }); return null }
    function App({ hidden }: { hidden: boolean }) { return React.createElement(React.Activity, { mode: hidden ? "hidden" : "visible" }, React.createElement(Capture)) }
    const mounted = render(React.createElement(App, { hidden: false }))
    let preparation!: Promise<void>
    act(() => { preparation = current.addPendingFiles([new File(["old"], "old.png", { type: "image/png" })]) })
    await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledTimes(1))
    act(() => mounted.rerender(React.createElement(App, { hidden: true })))
    act(() => mounted.rerender(React.createElement(App, { hidden: false })))
    await act(async () => { finish({ blob: new Blob(["old"]), width: 10, height: 10 }); await preparation })
    expect(current.pendingFiles).toEqual([])
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    prepareCommunityImageMock.mockResolvedValueOnce(null)
    await act(async () => current.addPendingFiles([new File(["new"], "new.txt")]))
    expect(current.pendingFiles.map((row) => row.file.name)).toEqual(["new.txt"])
  })
})

 it("clears a pending decode and its same-tab draft before any late result", async () => {
   let finish!: (value: { blob: Blob; width: number; height: number }) => void
   prepareCommunityImageMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
   const hook = await renderCapture("clear-scope")
   let adding!: Promise<void>
   act(() => { adding = hook.current.addPendingFiles([new File(["raw"], "old.png", { type: "image/png" })]) })
   await waitFor(() => expect(prepareCommunityImageMock).toHaveBeenCalledOnce())
   const signal = prepareCommunityImageMock.mock.calls[0][1] as AbortSignal
   act(() => hook.current.clearPendingFiles())
   expect(signal.aborted).toBe(true)
   expect(readComposerAttachmentSession("clear-scope")).toEqual([])
   expect(hook.current.pendingFiles).toEqual([])
   await act(async () => { finish({ blob: new Blob(["late"]), width: 1, height: 1 }); await adding })
   expect(hook.current.pendingFiles).toEqual([])
   expect(URL.createObjectURL).not.toHaveBeenCalled()
   expect(toastErrorMock).not.toHaveBeenCalled()
 })
