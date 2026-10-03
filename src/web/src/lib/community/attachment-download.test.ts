import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApplicationOwner, type ApplicationOwner } from "../application-owner"
import { attachmentDownloadKey, readAttachmentDownloadState, resetAttachmentDownloadsForTest, startAttachmentDownload } from "./attachment-download"
import { cancelFileDownload } from "../file-download"
const service = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock("../file-save", () => ({ downloadUrl: service.download, fileSaveMessage: (r: { status: string }) => r.status }))
let owner: ApplicationOwner
beforeEach(() => { owner = createApplicationOwner("viewer"); service.download.mockReset() })
afterEach(() => { resetAttachmentDownloadsForTest(owner); owner.queryClient.clear(); vi.useRealTimers() })
describe("shared native download owner", () => {
  it("deduplicates canonical IO by URL and filename and publishes the exact result", async () => {
    let finish!: (value: { status: string }) => void
    service.download.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const target = { name: "a.pdf", url: "/file/1" }, key = attachmentDownloadKey(owner, target)
    const first = startAttachmentDownload(owner, target), second = startAttachmentDownload(owner, target)
    expect(readAttachmentDownloadState(owner, key)).toEqual({ status: "downloading" })
    await Promise.resolve(); expect(service.download).toHaveBeenCalledOnce()
    finish({ status: "started" })
    expect(await first).toEqual({ status: "started" }); expect(await second).toEqual({ status: "started" })
    expect(readAttachmentDownloadState(owner, key)).toEqual({ status: "started" })
  })
  it("separates the same filename on different URLs", async () => {
    service.download.mockResolvedValue({ status: "started" })
    await Promise.all([startAttachmentDownload(owner, { name: "a", url: "/1" }), startAttachmentDownload(owner, { name: "a", url: "/2" })])
    expect(service.download).toHaveBeenCalledTimes(2)
  })
  it("cancels neutrally and retries after failure or cancellation", async () => {
    service.download.mockImplementationOnce((_url, _name, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "cancelled" }))))
    const target = { name: "a", url: "/1" }, key = attachmentDownloadKey(owner, target)
    const first = startAttachmentDownload(owner, target)
    await Promise.resolve(); await cancelFileDownload(owner, key); await first
    expect(readAttachmentDownloadState(owner, key)).toEqual({ status: "cancelled" })
    service.download.mockResolvedValueOnce({ status: "error", message: "failed" }).mockResolvedValueOnce({ status: "started" })
    await startAttachmentDownload(owner, target); expect(readAttachmentDownloadState(owner, key).status).toBe("error")
    await startAttachmentDownload(owner, target); expect(readAttachmentDownloadState(owner, key).status).toBe("started")
  })
  it("native GC evicts inactive results while an imperative consumer retains its flight", async () => {
    vi.useFakeTimers()
    let finish!: (value: { status: string }) => void
    service.download.mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValue({ status: "started" })
    const activeTarget = { name: "active", url: "/active" }, inactiveTarget = { name: "file", url: "/file" }
    const active = startAttachmentDownload(owner, activeTarget)
    await startAttachmentDownload(owner, inactiveTarget)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readAttachmentDownloadState(owner, attachmentDownloadKey(owner, inactiveTarget))).toEqual({ status: "idle" })
    expect(readAttachmentDownloadState(owner, attachmentDownloadKey(owner, activeTarget))).toEqual({ status: "downloading" })
    const sibling = startAttachmentDownload(owner, activeTarget)
    expect(service.download).toHaveBeenCalledTimes(2)
    finish({ status: "cancelled" }); await Promise.all([active, sibling])
    expect(readAttachmentDownloadState(owner, attachmentDownloadKey(owner, activeTarget))).toEqual({ status: "cancelled" })
  })
  it("an abandoned native flight cannot overwrite a recreated resource", async () => {
    let finish!: (value: { status: string }) => void
    service.download.mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValueOnce({ status: "started" })
    const target = { name: "a", url: "/1" }, key = attachmentDownloadKey(owner, target)
    const old = startAttachmentDownload(owner, target); await Promise.resolve()
    resetAttachmentDownloadsForTest(owner); await startAttachmentDownload(owner, target)
    finish({ status: "error" }); expect(await old).toEqual({ status: "cancelled" })
    expect(readAttachmentDownloadState(owner, key)).toEqual({ status: "started" })
  })
})
