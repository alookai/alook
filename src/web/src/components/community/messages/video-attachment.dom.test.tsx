import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, setupUser, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { tid } from "@/lib/community/testids"
import { VideoAttachment, videoPreviewUrl } from "./video-attachment"

const save = vi.hoisted(() => vi.fn())
vi.mock("@/lib/file-save", () => ({ downloadUrl: save, fileSaveMessage: (result: { status: string }) => result.status }))

const attachment = { kind: "file" as const, name: "clip.mp4", url: "/api/community/channels/c/attachments/a", contentType: "video/mp4", size: "2 KB" }
let intersect: IntersectionObserverCallback
let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>
let load: ReturnType<typeof vi.spyOn>
let views: Array<{ unmount: () => void }>

beforeEach(() => {
  views = []
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}; disconnect() {}; unobserve() {}
  })
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined)
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
  save.mockReset().mockResolvedValue({ status: "started" })
})
afterEach(() => { for (const view of views) view.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount() { const view = render(<VideoAttachment attachment={attachment} />); views.push(view); return view }
async function click(element: HTMLElement) { await act(async () => { fireEvent.click(element); await Promise.resolve() }) }
function position(player: HTMLElement, time: number, paused: boolean) {
  Object.defineProperties(player, {
    paused: { configurable: true, value: paused },
    ended: { configurable: true, value: false },
    readyState: { configurable: true, value: 1 },
    duration: { configurable: true, value: 60 },
  })
  ;(player as HTMLVideoElement).currentTime = time
  fireEvent.loadedMetadata(player)
}

describe("image-like native video", () => {
  it("waits for visibility and loads a muted paused native zero-start preview without playing", () => {
    const view = mount()
    expect(view.queryByTestId(tid.videoPreview(attachment.name))).toBeNull()
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const preview = view.getByTestId(tid.videoPreview(attachment.name)) as HTMLVideoElement
    Object.defineProperty(preview, "duration", { configurable: true, value: 12 })
    fireEvent.loadedMetadata(preview)
    expect(preview.currentTime).toBe(0)
    expect(preview).toHaveAttribute("src", `${attachment.url}#t=0`)
    expect(preview).toHaveAttribute("preload", "auto")
    expect(preview.muted).toBe(true)
    expect(preview.paused).toBe(true)
    expect(preview).not.toHaveAttribute("controls")
    expect(play).not.toHaveBeenCalled()
    fireEvent.seeked(preview)
    expect(view.getByTestId(tid.mediaBlock(attachment.name))).toHaveAttribute("data-preview-state", "ready")
  })

  it.each(["#t=2", "#xywh=0,0,20,20", "#"])("keeps the caller fragment %s", fragment => {
    expect(videoPreviewUrl(`${attachment.url}${fragment}`)).toBe(`${attachment.url}${fragment}`)
  })

  it("plays inside the card and downloads the original without opening a dialog or another play", async () => {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    expect(player).not.toHaveAttribute("controls")
    expect(player).toHaveAttribute("playsinline")
    expect(player).not.toHaveAttribute("controlslist")
    expect(view.getByTestId(tid.mediaBlock(attachment.name))).toContainElement(player)
    expect(view.queryByRole("dialog")).toBeNull()
    expect(play).toHaveBeenCalledOnce()
    await click(view.getByTestId(tid.mediaDownload(attachment.name)))
    await waitFor(() => expect(save).toHaveBeenCalledWith(attachment.url, attachment.name, expect.objectContaining({ signal: expect.any(AbortSignal) })))
    expect(play).toHaveBeenCalledOnce()
    const expand = view.getByTestId(tid.videoFullscreen(attachment.name))
    expand.focus()
    await click(expand)
    const fullscreen = view.getByTestId(tid.mediaPlayer(attachment.name))
    expect(view.getByRole("dialog")).toContainElement(fullscreen)
    expect(fullscreen).not.toHaveAttribute("controls")
    expect(fullscreen).toHaveAttribute("playsinline")
    expect(fullscreen).not.toHaveAttribute("controlslist")
    expect(view.getAllByTestId(tid.videoFullscreen(attachment.name))).toHaveLength(1)
    expect(view.getByRole("toolbar")).toContainElement(view.getByRole("button", { name: `Shrink ${attachment.name}` }))
    expect(player).not.toHaveAttribute("src")
    await click(view.getByRole("button", { name: `Shrink ${attachment.name}` }))
    expect(fullscreen).not.toHaveAttribute("src")
    expect(view.getByTestId(tid.mediaBlock(attachment.name))).toContainElement(view.getByTestId(tid.mediaPlayer(attachment.name)))
    await waitFor(() => expect(view.getByTestId(tid.videoFullscreen(attachment.name))).toHaveFocus())
    expect(pause).toHaveBeenCalled()
    expect(load).toHaveBeenCalled()
  })

  it.each([true, false])("preserves position and playing=%s through explicit fullscreen and return", async playing => {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const inline = view.getByTestId(tid.mediaPlayer(attachment.name))
    Object.assign(inline, { muted: true, volume: 0.35, playbackRate: 1.5 })
    position(inline, 7, !playing)
    await click(view.getByTestId(tid.videoFullscreen(attachment.name)))
    const fullscreen = view.getByTestId(tid.mediaPlayer(attachment.name))
    position(fullscreen, 0, !playing)
    expect((fullscreen as HTMLVideoElement).currentTime).toBe(7)
    expect(fullscreen).toMatchObject({ muted: true, volume: 0.35, playbackRate: 1.5 })
    expect(play).toHaveBeenCalledTimes(playing ? 2 : 1)
    expect(inline).not.toHaveAttribute("src")
    position(fullscreen, 11, !playing)
    await click(view.getByRole("button", { name: `Shrink ${attachment.name}` }))
    const returned = view.getByTestId(tid.mediaPlayer(attachment.name))
    position(returned, 0, !playing)
    expect((returned as HTMLVideoElement).currentTime).toBe(11)
    expect(returned).toMatchObject({ muted: true, volume: 0.35, playbackRate: 1.5 })
    expect(play).toHaveBeenCalledTimes(playing ? 3 : 1)
    expect(fullscreen).not.toHaveAttribute("src")
    expect(pause).toHaveBeenCalledWith()
  })

  it("expands an idle video without starting sound", async () => {
    const view = mount()
    await click(view.getByTestId(tid.videoFullscreen(attachment.name)))
    expect(view.getByRole("dialog")).toContainElement(view.getByTestId(tid.mediaPlayer(attachment.name)))
    expect(play).not.toHaveBeenCalled()
    await click(view.getByRole("button", { name: `Shrink ${attachment.name}` }))
    expect(play).not.toHaveBeenCalled()
  })

  it("drives play, pause, seek, sound and speed through the visible controls and native events", async () => {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name)) as HTMLVideoElement
    expect(view.getByRole("slider", { name: `Seek ${attachment.name}` })).toBeDisabled()
    position(player, 7, false)
    fireEvent.play(player)
    await click(view.getByRole("button", { name: `Pause ${attachment.name}` }))
    expect(pause).toHaveBeenCalledOnce()
    position(player, 7, true)
    fireEvent.pause(player)
    await click(view.getByRole("button", { name: `Play ${attachment.name}` }))
    expect(play).toHaveBeenCalledTimes(2)
    fireEvent.change(view.getByRole("slider", { name: `Seek ${attachment.name}` }), { target: { value: "22" } })
    expect(player.currentTime).toBe(22)
    fireEvent.keyDown(player, { key: "ArrowRight" })
    expect(player.currentTime).toBe(27)
    await click(view.getByRole("button", { name: `Mute ${attachment.name}` }))
    expect(player.muted).toBe(true)
    await click(view.getByRole("button", { name: `Unmute ${attachment.name}` }))
    expect(player.muted).toBe(false)
    await click(view.getByRole("button", { name: `Video settings: ${attachment.name}` }))
    fireEvent.change(view.getByRole("slider", { name: `Volume ${attachment.name}` }), { target: { value: "0.3" } })
    expect(player.volume).toBe(0.3)
    fireEvent.change(view.getByLabelText("Playback speed"), { target: { value: "1.5" } })
    expect(player.playbackRate).toBe(1.5)
    player.currentTime = 43
    fireEvent.timeUpdate(player)
    expect(view.getByText("0:43 / 1:00")).toBeInTheDocument()
    fireEvent.keyDown(player, { key: "m" })
    expect(player.muted).toBe(true)
    Object.defineProperty(player, "ended", { configurable: true, value: true })
    fireEvent.ended(player)
    expect(view.getByRole("button", { name: `Play ${attachment.name}` })).toBeInTheDocument()
  })

  it("returns from the masked preview with Escape, retaining state and focusing the new expand button", async () => {
    const user = setupUser()
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const inline = view.getByTestId(tid.mediaPlayer(attachment.name))
    position(inline, 8, true)
    await click(view.getByRole("button", { name: `Expand ${attachment.name}` }))
    const expanded = view.getByTestId(tid.mediaPlayer(attachment.name))
    position(expanded, 0, true)
    ;(expanded as HTMLVideoElement).currentTime = 12
    fireEvent.timeUpdate(expanded)
    await act(async () => { Object.assign(expanded, { muted: true, volume: 0.2, playbackRate: 2 }); await Promise.resolve() })
    await waitFor(() => expect(view.getByRole("button", { name: `Shrink ${attachment.name}` })).toHaveFocus())
    await user.keyboard("{Escape}")
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull())
    const returned = view.getByTestId(tid.mediaPlayer(attachment.name))
    position(returned, 0, true)
    expect(returned).toMatchObject({ currentTime: 12, muted: true, volume: 0.2, playbackRate: 2 })
    expect(expanded).not.toHaveAttribute("src")
    expect(view.queryByRole("dialog")).toBeNull()
    await waitFor(() => expect(view.getByRole("button", { name: `Expand ${attachment.name}` })).toHaveFocus())
    expect(play).toHaveBeenCalledOnce()
  })

  it("uses device volume guidance when native volume is fixed while leaving mute usable", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "volume", "get").mockReturnValue(1)
    vi.spyOn(HTMLMediaElement.prototype, "volume", "set").mockImplementation(() => undefined)
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name)) as HTMLVideoElement
    await click(view.getByRole("button", { name: `Video settings: ${attachment.name}` }))
    expect(view.queryByRole("slider", { name: `Volume ${attachment.name}` })).toBeNull()
    expect(view.getByText("Use your device’s volume buttons.")).toBeInTheDocument()
    await click(view.getByRole("button", { name: `Mute ${attachment.name}` }))
    expect(player.muted).toBe(true)
    expect(player.volume).toBe(1)
  })

  it("cancels a pending play from the control bar without showing its later rejection", async () => {
    let reject!: (error: unknown) => void
    play.mockReturnValueOnce(new Promise<void>((_, fail) => { reject = fail }))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    await click(view.getByRole("button", { name: `Pause ${attachment.name}` }))
    await act(async () => { reject(new DOMException("cancelled", "NotAllowedError")); await Promise.resolve() })
    expect(pause).toHaveBeenCalledOnce()
    expect(view.queryByRole("alert")).toBeNull()
    expect(view.getByRole("button", { name: `Play ${attachment.name}` })).toBeInTheDocument()
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

  it.each(["resolve", "reject"])("ignores a retired inline play %s after fullscreen handoff", async outcome => {
    let settle!: () => void
    let reject!: (error: unknown) => void
    play.mockReturnValueOnce(new Promise<void>((resolve, fail) => { settle = resolve; reject = fail }))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const old = view.getByTestId(tid.mediaPlayer(attachment.name))
    await click(view.getByTestId(tid.videoFullscreen(attachment.name)))
    const current = view.getByTestId(tid.mediaPlayer(attachment.name))
    await act(async () => { if (outcome === "resolve") settle(); else reject(new Error("retired")); await Promise.resolve() })
    expect(current).not.toBe(old)
    expect(old).not.toHaveAttribute("src")
    expect(view.queryByRole("alert")).toBeNull()
  })

  it.each([false, true])("restores retained sources after Activity resumes without auto-play, activated=%s", async activated => {
    function App({ hidden }: { hidden: boolean }) { return <React.Activity mode={hidden ? "hidden" : "visible"}><VideoAttachment attachment={attachment} /></React.Activity> }
    const view = render(<App hidden={false} />)
    views.push(view)
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    if (activated) await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const id = activated ? tid.mediaPlayer(attachment.name) : tid.videoPreview(attachment.name)
    const player = view.getByTestId(id)
    if (activated) position(player, 9, false)
    view.rerender(<App hidden />)
    expect(player).not.toHaveAttribute("src")
    view.rerender(<App hidden={false} />)
    expect(view.getByTestId(id)).toHaveAttribute("src", activated ? attachment.url : `${attachment.url}#t=0`)
    if (activated) {
      fireEvent.loadedMetadata(player)
      expect((player as HTMLVideoElement).currentTime).toBe(9)
    }
    expect(play).toHaveBeenCalledTimes(activated ? 1 : 0)
  })


  it("does not admit Play from a hidden page and rejects later native playback", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    expect(play).not.toHaveBeenCalled()
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    pause.mockClear()
    fireEvent.play(player)
    expect(pause).toHaveBeenCalledOnce()
  })

  it("pauses a current player when hidden even if its play promise settles later", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    let settle!: () => void
    play.mockReturnValueOnce(new Promise<void>(resolve => { settle = resolve }))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    hidden.mockReturnValue(true)
    fireEvent(document, new Event("visibilitychange"))
    expect(pause).toHaveBeenCalledOnce()
    await act(async () => { settle(); await Promise.resolve() })
    expect(pause).toHaveBeenCalledTimes(2)
    expect(view.queryByRole("alert")).toBeNull()
  })

  it("retains standard native fullscreen until it exits while hidden", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    let fullscreen: Element | null = null
    const original = Object.getOwnPropertyDescriptor(document, "fullscreenElement")
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen })
    try {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    fullscreen = view.getByTestId(tid.mediaBlock(attachment.name))
    hidden.mockReturnValue(true)
    fireEvent(document, new Event("visibilitychange"))
    expect(pause).not.toHaveBeenCalled()
    fullscreen = null
    fireEvent(document, new Event("fullscreenchange"))
    expect(pause).toHaveBeenCalledOnce()
    } finally {
      if (original) Object.defineProperty(document, "fullscreenElement", original)
      else Reflect.deleteProperty(document, "fullscreenElement")
    }
  })

  it("tracks native presentation on a replacement player after Retry", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    fireEvent.error(view.getByTestId(tid.mediaPlayer(attachment.name)))
    await click(view.getByTestId(tid.mediaRetry(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    Object.defineProperty(player, "webkitPresentationMode", { configurable: true, value: "fullscreen" })
    pause.mockClear()
    hidden.mockReturnValue(true)
    fireEvent(document, new Event("visibilitychange"))
    expect(pause).not.toHaveBeenCalled()
    Object.defineProperty(player, "webkitPresentationMode", { value: "inline" })
    fireEvent(player, new Event("webkitpresentationmodechanged"))
    expect(pause).toHaveBeenCalledOnce()
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
