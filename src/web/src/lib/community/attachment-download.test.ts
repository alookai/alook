import { afterEach, describe, expect, it, vi } from "vitest"
import { attachmentDownloadKey, readAttachmentDownloadState, resetAttachmentDownloadsForTest, startAttachmentDownload } from "./attachment-download"
import { cancelFileDownload } from "../file-download"
const service = vi.hoisted(() => ({ download: vi.fn() }))
vi.mock("../file-save", () => ({ downloadUrl: service.download, fileSaveMessage: (r: {status:string}) => r.status }))
afterEach(() => { resetAttachmentDownloadsForTest(); service.download.mockReset() })
describe("shared download owner", () => {
  it("deduplicates by source URL and publishes the exact native or browser result", async () => {
    let finish!: (value: {status:string}) => void
    service.download.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const target = { name: "a.pdf", url: "/file/1" }
    const first = startAttachmentDownload(target)
    expect(startAttachmentDownload(target)).toBe(first)
    expect(readAttachmentDownloadState(attachmentDownloadKey(target))).toEqual({status:"downloading"})
    await Promise.resolve(); expect(service.download).toHaveBeenCalledOnce()
    finish({status:"started"}); await first
    expect(readAttachmentDownloadState(target.url)).toEqual({status:"started"})
  })
  it("separates same filenames on different URLs", async () => {
    service.download.mockResolvedValue({status:"started"})
    await Promise.all([startAttachmentDownload({name:"a",url:"/1"}),startAttachmentDownload({name:"a",url:"/2"})])
    expect(service.download).toHaveBeenCalledTimes(2)
  })
  it("cancels neutrally and retries after failure or cancellation", async () => {
    service.download.mockImplementationOnce((_url, _name, {signal}) => new Promise(resolve => signal.addEventListener("abort", () => resolve({status:"cancelled"}))))
    const target = {name:"a",url:"/1"}; const first = startAttachmentDownload(target)
    await Promise.resolve(); cancelFileDownload(target.url); await first
    expect(readAttachmentDownloadState(target.url)).toEqual({status:"cancelled"})
    service.download.mockResolvedValueOnce({status:"error",message:"failed"}).mockResolvedValueOnce({status:"started"})
    await startAttachmentDownload(target); expect(readAttachmentDownloadState(target.url).status).toBe("error")
    await startAttachmentDownload(target); expect(readAttachmentDownloadState(target.url).status).toBe("started")
  })
  it("evicts old inactive results while preserving an in-flight download", async () => {
    let finish!: (value: { status: string }) => void
    service.download.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValue({ status: "started" })
    const active = startAttachmentDownload({ name: "active", url: "/active" })
    await Promise.resolve()
    for (let index = 0; index < 130; index++) await startAttachmentDownload({ name: "file", url: `/file/${index}` })
    expect(readAttachmentDownloadState("/file/0")).toEqual({ status: "idle" })
    expect(readAttachmentDownloadState("/file/129")).toEqual({ status: "started" })
    expect(readAttachmentDownloadState("/active")).toEqual({ status: "downloading" })
    expect(startAttachmentDownload({ name: "active", url: "/active" })).toBe(active)
    finish({ status: "cancelled" })
    await active
    expect(readAttachmentDownloadState("/active")).toEqual({ status: "cancelled" })
  })
  it("does not let an abandoned flight overwrite a new attempt", async () => {
    let finish!: (value: {status:string}) => void
    service.download.mockReturnValueOnce(new Promise(resolve => {finish=resolve})).mockResolvedValueOnce({status:"started"})
    const target={name:"a",url:"/1"}; const old=startAttachmentDownload(target); await Promise.resolve()
    resetAttachmentDownloadsForTest(); await startAttachmentDownload(target)
    finish({status:"error"}); await old
    expect(readAttachmentDownloadState(target.url)).toEqual({status:"started"})
  })
})
