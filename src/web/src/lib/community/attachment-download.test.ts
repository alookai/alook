import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  attachmentDownloadKey,
  readAttachmentDownloadState,
  resetAttachmentDownloadsForTest,
  startAttachmentDownload,
} from "./attachment-download"

type AnchorMock = {
  href: string
  download: string
  hidden: boolean
  click: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function installBrowserMocks() {
  const order: string[] = []
  const anchor: AnchorMock = {
    href: "",
    download: "",
    hidden: false,
    click: vi.fn(() => order.push("click")),
    remove: vi.fn(() => order.push("remove")),
  }
  const createObjectURL = vi.fn(() => {
    order.push("create-url")
    return "blob:attachment"
  })
  const revokeObjectURL = vi.fn(() => order.push("revoke-url"))
  vi.stubGlobal("document", {
    createElement: vi.fn(() => anchor),
  })
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })
  return { anchor, createObjectURL, revokeObjectURL, order }
}

describe("attachment download owner", () => {
  beforeEach(() => resetAttachmentDownloadsForTest())
  afterEach(() => {
    resetAttachmentDownloadsForTest()
    vi.unstubAllGlobals()
  })

  it("deduplicates one in-flight attachment until Blob completion and one save trigger", async () => {
    const browser = installBrowserMocks()
    const bytes = new Blob(["complete"])
    let resolveBlob!: (blob: Blob) => void
    const blob = vi.fn(() => new Promise<Blob>((resolve) => { resolveBlob = resolve }))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob })
    vi.stubGlobal("fetch", fetchMock)
    const target = {
      name: "报告.pdf",
      url: "/api/community/channels/channel-1/attachments/attachment-1",
    }

    const first = startAttachmentDownload(target)
    const second = startAttachmentDownload(target)
    expect(second).toBe(first)
    expect(readAttachmentDownloadState(attachmentDownloadKey(target))).toEqual({ status: "downloading" })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(target.url, { credentials: "same-origin" })
    expect(browser.anchor.click).not.toHaveBeenCalled()
    expect(readAttachmentDownloadState(target.url)).toEqual({ status: "downloading" })

    await vi.waitFor(() => expect(blob).toHaveBeenCalledOnce())
    resolveBlob(bytes)
    await first
    expect(browser.createObjectURL).toHaveBeenCalledWith(bytes)
    expect(browser.anchor).toEqual(expect.objectContaining({
      href: "blob:attachment",
      download: "报告.pdf",
      hidden: true,
    }))
    expect(browser.anchor.click).toHaveBeenCalledOnce()
    expect(browser.anchor.remove).toHaveBeenCalledOnce()
    expect(browser.revokeObjectURL).toHaveBeenCalledOnce()
    expect(browser.order).toEqual(["create-url", "click", "remove", "revoke-url"])
    expect(readAttachmentDownloadState(target.url)).toEqual({ status: "success" })
  })

  it("does not key same-named attachments from different channel routes together", async () => {
    installBrowserMocks()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(new Blob(["bytes"])),
    })
    vi.stubGlobal("fetch", fetchMock)
    const first = { name: "report.pdf", url: "/api/community/channels/channel-1/attachments/a1" }
    const second = { name: "report.pdf", url: "/api/community/channels/channel-2/attachments/a1" }

    await Promise.all([startAttachmentDownload(first), startAttachmentDownload(second)])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(attachmentDownloadKey(first)).not.toBe(attachmentDownloadKey(second))
  })

  it.each([
    ["network", () => Promise.reject(new TypeError("network failed"))],
    ["abort", () => Promise.reject(new DOMException("Aborted", "AbortError"))],
    ["non-2xx", () => Promise.resolve({ ok: false, status: 403, blob: vi.fn() })],
    ["Blob", () => Promise.resolve({ ok: true, status: 200, blob: vi.fn().mockRejectedValue(new Error("Blob failed")) })],
  ])("makes %s failure visible and allows a later retry", async (_kind, failedFetch) => {
    const browser = installBrowserMocks()
    const fetchMock = vi.fn()
      .mockImplementationOnce(failedFetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob(["retry"])),
      })
    vi.stubGlobal("fetch", fetchMock)
    const target = { name: "report.pdf", url: "/api/community/channels/c1/attachments/a1" }

    await startAttachmentDownload(target)
    expect(readAttachmentDownloadState(target.url).status).toBe("error")
    expect(browser.anchor.click).not.toHaveBeenCalled()

    await startAttachmentDownload(target)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(browser.anchor.click).toHaveBeenCalledOnce()
    expect(readAttachmentDownloadState(target.url)).toEqual({ status: "success" })
  })

  it("cleans up a created anchor and object URL when the save trigger throws", async () => {
    const browser = installBrowserMocks()
    browser.anchor.click.mockImplementationOnce(() => { throw new Error("save blocked") })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn().mockResolvedValue(new Blob(["bytes"])),
    }))
    const target = { name: "report.pdf", url: "/api/community/channels/c1/attachments/a1" }

    await startAttachmentDownload(target)
    expect(readAttachmentDownloadState(target.url).status).toBe("error")
    expect(browser.anchor.remove).toHaveBeenCalledOnce()
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:attachment")
  })
})
