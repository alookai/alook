import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { tid } from "@/lib/community/testids"
import { VideoAttachment, prepareVideoPreviewFrame } from "./video-attachment"

const save = vi.hoisted(() => vi.fn())
vi.mock("@/lib/file-save", () => ({ downloadUrl: save, fileSaveMessage: (result: { status: string }) => result.status }))

const attachment = { kind: "file" as const, name: "clip.mp4", url: "/api/community/channels/c/attachments/a", contentType: "video/mp4", size: "2 KB" }
let intersect: IntersectionObserverCallback
let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>
let load: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}; disconnect() {}; unobserve() {}
  })
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
  save.mockReset().mockResolvedValue({ status: "started" })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount() { return render(<VideoAttachment attachment={attachment} />) }
async function click(element: HTMLElement) { await act(async () => { fireEvent.click(element); await Promise.resolve() }) }

describe("image-like native video", () => {
  it("waits for visibility and seeks a muted paused preview without starting playback", () => {
    const view = mount()
    expect(view.queryByTestId(tid.videoPreview(attachment.name))).toBeNull()
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const preview = view.getByTestId(tid.videoPreview(attachment.name)) as HTMLVideoElement
    Object.defineProperty(preview, "duration", { configurable: true, value: 12 })
    fireEvent.loadedMetadata(preview)
    expect(preview.currentTime).toBe(0.1)
    expect(preview.muted).toBe(true)
    expect(preview.paused).toBe(true)
    expect(preview).not.toHaveAttribute("controls")
    expect(play).not.toHaveBeenCalled()
    fireEvent.seeked(preview)
    expect(view.getByTestId(tid.mediaBlock(attachment.name))).toHaveAttribute("data-preview-state", "ready")
  })

  it("keeps a caller's media-time fragment and an already-positioned preview", () => {
    const preview = document.createElement("video")
    Object.defineProperty(preview, "duration", { value: 0.08 })
    prepareVideoPreviewFrame(preview)
    expect(preview.currentTime).toBe(0.04)
    preview.currentTime = 0; preview.src = "https://alook.test/clip.mp4#t=2"
    prepareVideoPreviewFrame(preview)
    expect(preview.currentTime).toBe(0)
    preview.src = "https://alook.test/clip.mp4"; preview.currentTime = 3
    prepareVideoPreviewFrame(preview)
    expect(preview.currentTime).toBe(3)
  })

  it("opens a native controlled player and downloads the original without another play", async () => {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    expect(player).toHaveAttribute("controls")
    expect(player).toHaveAttribute("playsinline")
    expect(play).toHaveBeenCalledOnce()
    await click(view.getByTestId(tid.mediaDownload(attachment.name)))
    await waitFor(() => expect(save).toHaveBeenCalledWith(attachment.url, attachment.name, expect.objectContaining({ signal: expect.any(AbortSignal) })))
    expect(play).toHaveBeenCalledOnce()
    await click(view.getByRole("button", { name: "Close video preview" }))
    expect(player).not.toHaveAttribute("src")
    expect(pause).toHaveBeenCalled()
    expect(load).toHaveBeenCalled()
  })

  it("keeps a blocked player retryable and leaves unsupported video downloadable", async () => {
    play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    expect(view.getByRole("alert")).toHaveTextContent("Playback was blocked")
    await click(view.getByTestId(tid.mediaRetry(attachment.name)))
    expect(play).toHaveBeenCalledTimes(2)
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    fireEvent.error(player)
    expect(view.getByRole("alert")).toHaveTextContent("download the original")
    expect(view.getByTestId(tid.mediaDownload(attachment.name))).toBeEnabled()
    await click(view.getByTestId(tid.mediaRetry(attachment.name)))
    expect(view.getByTestId(tid.mediaPlayer(attachment.name))).not.toBe(player)
    expect(player).not.toHaveAttribute("src")
    expect(play).toHaveBeenCalledTimes(3)
  })

  it.each(["resolve", "reject"])("ignores a retired play %s after close and reopen", async outcome => {
    let settle!: () => void
    let reject!: (error: unknown) => void
    play.mockReturnValueOnce(new Promise<void>((resolve, fail) => { settle = resolve; reject = fail }))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const old = view.getByTestId(tid.mediaPlayer(attachment.name))
    await click(view.getByRole("button", { name: "Close video preview" }))
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const current = view.getByTestId(tid.mediaPlayer(attachment.name))
    await act(async () => { if (outcome === "resolve") settle(); else reject(new Error("retired")); await Promise.resolve() })
    expect(current).not.toBe(old)
    expect(old).not.toHaveAttribute("src")
    expect(view.queryByRole("alert")).toBeNull()
  })

  it("restores retained sources after Activity resumes without automatically resuming playback", async () => {
    function App({ hidden }: { hidden: boolean }) { return <React.Activity mode={hidden ? "hidden" : "visible"}><VideoAttachment attachment={attachment} /></React.Activity> }
    const view = render(<App hidden={false} />)
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const preview = view.getByTestId(tid.videoPreview(attachment.name))
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    view.rerender(<App hidden />)
    expect(preview).not.toHaveAttribute("src")
    expect(player).not.toHaveAttribute("src")
    view.rerender(<App hidden={false} />)
    expect(view.getByTestId(tid.videoPreview(attachment.name))).toHaveAttribute("src", attachment.url)
    expect(view.getByTestId(tid.mediaPlayer(attachment.name))).toHaveAttribute("src", attachment.url)
    expect(play).toHaveBeenCalledOnce()
  })

  it("pauses hidden playback, retains visible native fullscreen, and removes listeners on unmount", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    Object.defineProperty(player, "webkitDisplayingFullscreen", { configurable: true, value: true })
    hidden.mockReturnValue(true)
    fireEvent(document, new Event("visibilitychange"))
    expect(pause).not.toHaveBeenCalled()
    Object.defineProperty(player, "webkitDisplayingFullscreen", { value: false })
    fireEvent(player, new Event("webkitendfullscreen"))
    expect(pause).toHaveBeenCalledOnce()
    view.unmount()
    expect(player).not.toHaveAttribute("src")
    const calls = pause.mock.calls.length
    fireEvent(document, new Event("visibilitychange"))
    expect(pause).toHaveBeenCalledTimes(calls)
  })
})
