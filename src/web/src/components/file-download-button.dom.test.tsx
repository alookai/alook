import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { FileDownloadButton } from "./file-download-button"
import { resetFileDownloadsForTest } from "@/lib/file-download"
const service = vi.hoisted(() => ({ download: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/file-save", async importOriginal => ({ ...await importOriginal<object>(), downloadUrl: service.download }))
vi.mock("sonner", () => ({ toast: { success: service.success, error: service.error } }))
afterEach(() => { resetFileDownloadsForTest(); vi.clearAllMocks() })
describe("file download control", () => {
  it.each(["saved", "started", "error", "cancelled"] as const)("announces %s truthfully", async status => {
    service.download.mockResolvedValue({ status })
    const view = render(<FileDownloadButton url="/file" filename="a.pdf">Get file</FileDownloadButton>)
    await act(async () => { view.getByRole("button").click() })
    const text = status === "saved" ? "Saved" : status === "started" ? "Download started" : status === "error" ? "Couldn’t save — retry" : ""
    expect(view.getByRole("status").textContent).toBe(text)
    if (status === "error") expect(service.error).toHaveBeenCalledWith(text)
    else if (status !== "cancelled") expect(service.success).toHaveBeenCalledWith(text)
    else { expect(service.error).not.toHaveBeenCalled(); expect(service.success).not.toHaveBeenCalled() }
  })
  it("announces the native share handoff and permits another download", async () => {
    service.download.mockResolvedValue({ status: "started", destination: "share" })
    const view = render(<FileDownloadButton url="/file" filename="a.pdf">Get file</FileDownloadButton>)
    await act(async () => { view.getByRole("button").click() })
    expect(view.getByRole("status")).toHaveTextContent("Share sheet opened")
    expect(service.success).toHaveBeenCalledWith("Share sheet opened")
    expect(service.success).not.toHaveBeenCalledWith("Saved")
    await act(async () => { view.getByRole("button").click() })
    expect(service.download).toHaveBeenCalledTimes(2)
  })
  it("keeps the busy action cancellable and allows retry", async () => {
    service.download.mockImplementationOnce((_url, _name, { signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "cancelled" }))))
      .mockResolvedValueOnce({ status: "started" })
    const view = render(<FileDownloadButton url="/file" filename="a.pdf">Get file</FileDownloadButton>)
    await act(async () => { view.getByRole("button").click() })
    expect(view.getByRole("button", { name: "Cancel download a.pdf" })).toBeEnabled()
    await act(async () => { view.getByRole("button").click() })
    expect(view.getByRole("status").textContent).toBe("")
    await act(async () => { view.getByRole("button").click() })
    expect(view.getByRole("status")).toHaveTextContent("Download started")
  })
})
