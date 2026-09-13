import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Artifact } from "@alook/shared"
import { act, render } from "@/test/react-dom-harness"
import { ArtifactCard } from "./agent-chat/chat-view-parts"
import { IssueAttachmentList } from "./issues/issue-attachment-list"
import { useArtifactClick } from "./use-artifact-click"
import { resetFileDownloadsForTest } from "@/lib/file-download"

const service = vi.hoisted(() => ({ download: vi.fn(), loading: vi.fn<(text: string, options: { action: { label: string; onClick: () => void } }) => number>(() => 1), dismiss: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/file-save", async importOriginal => ({ ...await importOriginal<object>(), downloadUrl: service.download }))
vi.mock("sonner", () => ({ toast: service }))
const binary = { id: "binary", filename: "报告.bin", content_type: "application/octet-stream", size: 36, has_thumbnail: false } as Artifact
function Card({ artifact = binary, preview = vi.fn(), image }: { artifact?: Artifact; preview?: (artifact: Artifact) => void; image?: (artifact: Artifact) => void }) {
  const click = useArtifactClick("workspace", preview, image)
  return <ArtifactCard artifact={artifact} workspaceId="workspace" version={1} hasDuplicates={false} onClick={click} />
}
afterEach(() => { resetFileDownloadsForTest(); vi.clearAllMocks() })
describe("artifact card click controller", () => {
  it("routes the actual binary card through authenticated file-save and exposes retry", async () => {
    service.download.mockResolvedValueOnce({ status: "error", message: "network" }).mockResolvedValueOnce({ status: "started" })
    const preview = vi.fn()
    const view = render(<Card preview={preview} />)
    await act(async () => { view.getByRole("button").click() })
    expect(service.download).toHaveBeenCalledWith("/api/artifacts/binary/content?workspace_id=workspace&download=1", "报告.bin", { signal: expect.any(AbortSignal) })
    expect(preview).not.toHaveBeenCalled()
    expect(service.error).toHaveBeenCalledWith("Couldn’t save — retry", expect.objectContaining({ action: expect.objectContaining({ label: "Retry" }) }))
    await act(async () => { service.error.mock.calls[0][1].action.onClick() })
    expect(service.download).toHaveBeenCalledTimes(2)
    expect(service.success).toHaveBeenCalledWith("Download started")
  })
  it("allows cancellation from the download notification and a fresh card retry", async () => {
    service.download.mockImplementationOnce((_url, _name, { signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "cancelled" })))).mockResolvedValueOnce({ status: "saved" })
    const view = render(<Card />)
    await act(async () => { view.getByRole("button").click() })
    await act(async () => { service.loading.mock.calls[0][1].action.onClick() })
    expect(service.error).not.toHaveBeenCalled()
    expect(service.success).not.toHaveBeenCalled()
    await act(async () => { view.getByRole("button").click() })
    expect(service.success).toHaveBeenCalledWith("Saved")
  })
  it("a repeated card click cancels the active download without starting a duplicate", async () => {
    let signal!: AbortSignal
    service.download.mockImplementationOnce((_url, _name, options) => {
      signal = options.signal
      return new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "cancelled" })))
    }).mockResolvedValueOnce({ status: "started" })
    const view = render(<Card />)
    await act(async () => { view.getByRole("button").click() })
    expect(signal.aborted).toBe(false)
    await act(async () => { view.getByRole("button").click() })
    expect(signal.aborted).toBe(true)
    expect(service.download).toHaveBeenCalledTimes(1)
    expect(service.success).not.toHaveBeenCalled()
    expect(service.error).not.toHaveBeenCalled()
    await act(async () => { view.getByRole("button").click() })
    expect(service.download).toHaveBeenCalledTimes(2)
    expect(service.success).toHaveBeenCalledWith("Download started")
  })
  it.each([true, false])("preserves the image preview choice (lightbox=%s)", async lightbox => {
    const preview = vi.fn(), image = vi.fn()
    const artifact = { ...binary, content_type: "image/png", filename: "a.png" }
    const view = render(<Card artifact={artifact} preview={preview} image={lightbox ? image : undefined} />)
    await act(async () => { view.getByRole("button").click() })
    expect(lightbox ? image : preview).toHaveBeenCalledWith(artifact)
    expect(lightbox ? preview : image).not.toHaveBeenCalled()
    expect(service.download).not.toHaveBeenCalled()
  })
  it("keeps text artifacts in the preview sheet", async () => {
    const preview = vi.fn()
    const artifact = { ...binary, content_type: "text/plain" }
    const view = render(<Card artifact={artifact} preview={preview} />)
    await act(async () => { view.getByRole("button").click() })
    expect(preview).toHaveBeenCalledWith(artifact)
    expect(service.download).not.toHaveBeenCalled()
  })
})

describe("issue attachment list click", () => {
  it("downloads a binary through the owner, even when a preview callback exists", async () => {
    service.download.mockResolvedValue({ status: "started" })
    const preview = vi.fn()
    const view = render(<IssueAttachmentList artifacts={[binary]} workspaceId="workspace" onArtifactClick={preview} />)
    await act(async () => { view.getByRole("button").click() })
    expect(service.download).toHaveBeenCalledWith("/api/artifacts/binary/content?workspace_id=workspace&download=1", "报告.bin", { signal: expect.any(AbortSignal) })
    expect(preview).not.toHaveBeenCalled()
    expect(view.getByRole("status")).toHaveTextContent("Download started")
    expect(view.queryByRole("link")).toBeNull()
  })
  it("preserves preview callbacks for text attachments", async () => {
    const artifact = { ...binary, content_type: "text/plain" }
    const preview = vi.fn()
    const view = render(<IssueAttachmentList artifacts={[artifact]} workspaceId="workspace" onArtifactClick={preview} />)
    await act(async () => { view.getByRole("button").click() })
    expect(preview).toHaveBeenCalledWith(artifact)
    expect(service.download).not.toHaveBeenCalled()
  })
})
