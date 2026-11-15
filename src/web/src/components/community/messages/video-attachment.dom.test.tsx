import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, mockElementGeometry, setupUser, waitFor } from "@/test/react-dom-harness"
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
let popoverStyle: HTMLStyleElement
const popoverDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "popover")

beforeEach(() => {
  views = []
  Reflect.deleteProperty(HTMLElement.prototype, "popover")
  popoverStyle = document.createElement("style")
  popoverStyle.textContent = "[popover][data-open] { display: block !important; }"
  document.head.appendChild(popoverStyle)
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}; disconnect() {}; unobserve() {}
  })
  vi.stubGlobal("CSS", Object.assign(Object.create(CSS), { supports: () => false }))
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false })
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  })
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true })
    this.dispatchEvent(new Event("pause"))
  })
  load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
  save.mockReset().mockResolvedValue({ status: "started" })
})
afterEach(() => { popoverStyle.remove(); for (const view of views) view.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); if (popoverDescriptor) Object.defineProperty(HTMLElement.prototype, "popover", popoverDescriptor) })

function mount() { const view = render(<VideoAttachment attachment={attachment} />); views.push(view); return view }
async function click(element: HTMLElement) { await act(async () => { fireEvent.click(element); await Promise.resolve() }) }
async function notify(event: () => unknown) { await act(async () => { event(); await Promise.resolve() }) }
async function elapse(milliseconds: number) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) }) }
async function position(player: HTMLElement, time: number, paused: boolean) {
  Object.defineProperties(player, {
    paused: { configurable: true, value: paused },
    ended: { configurable: true, value: false },
    readyState: { configurable: true, value: 4 },
    duration: { configurable: true, value: 60 },
  })
  ;(player as HTMLVideoElement).currentTime = time
  mockElementGeometry(player, { width: 300, height: 200 })
  if (player.parentElement) mockElementGeometry(player.parentElement, { width: 300, height: 200 })
  await notify(() => fireEvent.loadedMetadata(player))
  await notify(() => fireEvent.durationChange(player))
  await notify(() => fireEvent.timeUpdate(player))
}

describe("image-like native video", () => {
  it("waits for visibility and loads a muted paused native zero-start preview without playing", async () => {
    const view = mount()
    expect(view.queryByTestId(tid.videoPreview(attachment.name))).toBeNull()
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const preview = view.getByTestId(tid.videoPreview(attachment.name)) as HTMLVideoElement
    Object.defineProperty(preview, "duration", { configurable: true, value: 12 })
    await notify(() => fireEvent.loadedMetadata(preview))
    expect(preview.currentTime).toBe(0)
    expect(preview).toHaveAttribute("src", `${attachment.url}#t=0`)
    expect(preview).toHaveAttribute("preload", "auto")
    expect(preview.muted).toBe(true)
    expect(preview.paused).toBe(true)
    expect(preview).not.toHaveAttribute("controls")
    expect(play).not.toHaveBeenCalled()
    await notify(() => fireEvent.seeked(preview))
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
    expect(view.getByRole("toolbar", { hidden: true })).toContainElement(view.getByRole("button", { name: `Shrink ${attachment.name}` }))
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
    await position(inline, 7, !playing)
    await click(view.getByTestId(tid.videoFullscreen(attachment.name)))
    const fullscreen = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(fullscreen, 0, !playing)
    expect((fullscreen as HTMLVideoElement).currentTime).toBe(7)
    expect(fullscreen).toMatchObject({ muted: true, volume: 0.35, playbackRate: 1.5 })
    expect(play).toHaveBeenCalledTimes(playing ? 2 : 1)
    expect(inline).not.toHaveAttribute("src")
    await position(fullscreen, 11, !playing)
    await click(view.getByRole("button", { name: `Shrink ${attachment.name}` }))
    const returned = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(returned, 0, !playing)
    expect((returned as HTMLVideoElement).currentTime).toBe(11)
    expect(returned).toMatchObject({ muted: true, volume: 0.35, playbackRate: 1.5 })
    expect(play).toHaveBeenCalledTimes(playing ? 3 : 1)
    expect(fullscreen).not.toHaveAttribute("src")
    expect(pause).toHaveBeenCalledWith()
  })

  it.each(["button", "key", "mouse", "touch"] as const)("uses %s expansion and return only through the Alook mask", async input => {
    const view = mount()
    const nativeEntry = vi.fn().mockResolvedValue(undefined)
    const interceptNativeEntry = (player: HTMLElement) => {
      Object.defineProperty(player.parentElement, "requestFullscreen", { configurable: true, value: nativeEntry })
      Object.defineProperty(player.parentElement, "webkitRequestFullscreen", { configurable: true, value: nativeEntry })
      Object.defineProperty(player, "webkitEnterFullscreen", { configurable: true, value: nativeEntry })
    }
    const activate = async (player: HTMLElement) => {
      if (input === "button") await click(view.getByTestId(tid.videoFullscreen(attachment.name)))
      else if (input === "key") {
        act(() => player.focus())
        await notify(() => fireEvent.keyDown(player, { key: "f" }))
      } else {
        for (let tap = 0; tap < 2; tap += 1) {
          const props = { pointerType: input, pointerId: 1, clientX: 150, clientY: 70, button: 0, isPrimary: true }
          await notify(() => fireEvent.pointerDown(player, props))
          await notify(() => fireEvent.pointerUp(player, props))
        }
      }
    }
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const inline = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(inline, 7, false)
    interceptNativeEntry(inline)
    await activate(inline)
    const expanded = view.getByTestId(tid.mediaPlayer(attachment.name))
    expect(view.getByRole("dialog")).toContainElement(expanded)
    await position(expanded, 0, false)
    expect((expanded as HTMLVideoElement).currentTime).toBe(7)
    await position(expanded, 11, false)
    interceptNativeEntry(expanded)
    await activate(expanded)
    expect(view.queryByRole("dialog")).toBeNull()
    const returned = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(returned, 0, false)
    expect((returned as HTMLVideoElement).currentTime).toBe(11)
    expect(nativeEntry).not.toHaveBeenCalled()
    expect(document.fullscreenElement ?? null).toBeNull()
    expect(inline).not.toHaveAttribute("src")
    expect(expanded).not.toHaveAttribute("src")
  })

  it("shows only Play before activation and admits one control bar after Play", async () => {
    const view = mount()
    expect(view.getByRole("button", { name: `Play ${attachment.name}` })).toBeInTheDocument()
    expect(view.queryByRole("toolbar")).toBeNull()
    expect(view.queryByTestId(tid.mediaDownload(attachment.name))).toBeNull()
    expect(view.queryByTestId(tid.videoFullscreen(attachment.name))).toBeNull()
    expect(play).not.toHaveBeenCalled()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const toolbar = view.getByRole("toolbar", { hidden: true })
    expect(view.getAllByRole("toolbar")).toHaveLength(1)
    expect(toolbar).toContainElement(view.getByTestId(tid.mediaDownload(attachment.name)))
    expect(toolbar).toContainElement(view.getByRole("button", { name: `Expand ${attachment.name}` }))
    expect(view.queryByRole("dialog")).toBeNull()
    expect(play).toHaveBeenCalledOnce()
  })

  it("drives play, pause, seek, sound and speed through the visible controls and native events", async () => {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name)) as HTMLVideoElement
    expect(view.getByRole("slider", { name: `Seek ${attachment.name}` })).toHaveAttribute("aria-disabled", "true")
    await position(player, 7, false)
    await notify(() => fireEvent.play(player))
    await click(view.getByRole("button", { name: `Pause ${attachment.name}` }))
    expect(pause).toHaveBeenCalledOnce()
    await position(player, 7, true)
    await notify(() => fireEvent.pause(player))
    await click(view.getByRole("button", { name: `Play ${attachment.name}` }))
    expect(play).toHaveBeenCalledTimes(2)
    const seek = view.getByRole("slider", { name: `Seek ${attachment.name}` })
    await notify(() => fireEvent.keyDown(seek, { key: "End" }))
    expect(player.currentTime).toBe(60)
    await notify(() => fireEvent.keyDown(seek, { key: "Home" }))
    expect(player.currentTime).toBe(0)
    act(() => player.focus())
    await notify(() => fireEvent.keyDown(player, { key: "ArrowRight" }))
    expect(player.currentTime).toBe(10)
    await notify(() => fireEvent.seeked(player))
    await click(view.getByRole("button", { name: `Mute ${attachment.name}` }))
    expect(player.muted).toBe(true)
    await click(view.getByRole("button", { name: `Unmute ${attachment.name}` }))
    expect(player.muted).toBe(false)
    await click(view.getByRole("button", { name: `Mute ${attachment.name}` }))
    const volume = await view.findByRole("slider", { name: `Volume ${attachment.name}` })
    await notify(() => fireEvent.keyDown(volume, { key: "End" }))
    await notify(() => fireEvent.keyDown(volume, { key: "ArrowLeft" }))
    expect(player.volume).toBeLessThan(1)
    expect(player.volume).toBeGreaterThan(0)
    await click(view.getByRole("button", { name: `Video settings: ${attachment.name}` }))
    await click(view.getByRole("menuitemradio", { name: /1.5/ }))
    expect(player.playbackRate).toBe(1.5)
    player.currentTime = 43
    await notify(() => fireEvent.timeUpdate(player))
    await waitFor(() => expect(view.getByText("0:43")).toBeInTheDocument())
    act(() => player.focus())
    await notify(() => fireEvent.keyDown(player, { key: "m" }))
    expect(player.muted).toBe(true)
    Object.defineProperty(player, "ended", { configurable: true, value: true })
    await notify(() => fireEvent.ended(player))
    expect(view.getByRole("button", { name: `Replay ${attachment.name}` })).toBeInTheDocument()
  })

  it("returns from the masked preview with Escape, retaining state and focusing the new expand button", async () => {
    const user = setupUser()
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const inline = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(inline, 8, true)
    await click(view.getByRole("button", { name: `Expand ${attachment.name}` }))
    const expanded = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(expanded, 0, true)
    ;(expanded as HTMLVideoElement).currentTime = 12
    await notify(() => fireEvent.timeUpdate(expanded))
    await act(async () => { Object.assign(expanded, { muted: true, volume: 0.2, playbackRate: 2 }); await Promise.resolve() })
    await waitFor(() => expect(view.getByRole("button", { name: `Shrink ${attachment.name}` })).toHaveFocus())
    await user.keyboard("{Escape}")
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull())
    const returned = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(returned, 0, true)
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
    play.mockImplementationOnce(function (this: HTMLMediaElement) {
      Object.defineProperty(this, "paused", { configurable: true, value: false })
      this.dispatchEvent(new Event("play"))
      return new Promise<void>((_, fail) => { reject = fail })
    })
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    await click(view.getByRole("button", { name: `Pause ${attachment.name}` }))
    await act(async () => { reject(new DOMException("cancelled", "NotAllowedError")); await Promise.resolve() })
    expect(pause).toHaveBeenCalledOnce()
    expect(view.queryByRole("alert")).toBeNull()
    expect(view.getByRole("button", { name: `Play ${attachment.name}` })).toBeInTheDocument()
  })

  it("hides idle playing controls and reveals them on mouse or keyboard without stopping playback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name)) as HTMLVideoElement
    await position(player, 1, false)
    const toolbar = view.getByRole("toolbar", { hidden: true })
    await elapse(2_600)
    expect(toolbar).not.toHaveAttribute("data-visible")
    expect(toolbar).toHaveAttribute("inert")
    await notify(() => fireEvent.pointerMove(player, { pointerType: "mouse" }))
    expect(toolbar).toHaveAttribute("data-visible")
    await elapse(2_600)
    expect(toolbar).not.toHaveAttribute("data-visible")
    act(() => player.focus())
    await notify(() => fireEvent.keyDown(player, { key: "m" }))
    expect(toolbar).toHaveAttribute("data-visible")
    expect(player.muted).toBe(true)
    expect(pause).not.toHaveBeenCalled()
    expect(play).toHaveBeenCalledOnce()
  })

  it("uses touch to reveal hidden controls without pausing, then pauses through the visible button", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(player, 1, false)
    await elapse(2_600)
    await notify(() => fireEvent.pointerDown(player, { pointerType: "touch", pointerId: 1, clientX: 150, clientY: 70, button: 0, isPrimary: true }))
    await notify(() => fireEvent.pointerUp(player, { pointerType: "touch", pointerId: 1, clientX: 150, clientY: 70, button: 0, isPrimary: true }))
    await elapse(500)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    expect(pause).not.toHaveBeenCalled()
    await click(view.getByRole("button", { name: `Pause ${attachment.name}` }))
    expect(pause).toHaveBeenCalledOnce()
  })

  it("keeps paused and failed playback controls visible", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(player, 1, false)
    await elapse(2_600)
    await position(player, 1, true)
    await notify(() => fireEvent.pause(player))
    await elapse(5_000)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    await position(player, 1, false)
    await notify(() => fireEvent.error(player))
    await elapse(5_000)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    expect(view.getByTestId(tid.mediaRetry(attachment.name))).toBeInTheDocument()
  })

  it.each(["started", "error"] as const)("keeps an active download visible through its %s outcome", async outcome => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    let finish!: (value: { status: "started" } | { status: "error"; message: string }) => void
    save.mockReturnValueOnce(new Promise<{ status: "started" } | { status: "error"; message: string }>(resolve => { finish = resolve }))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    await position(view.getByTestId(tid.mediaPlayer(attachment.name)), 1, false)
    await click(view.getByTestId(tid.mediaDownload(attachment.name)))
    await elapse(0)
    expect(view.getByRole("button", { name: `Cancel download ${attachment.name}` })).toBeInTheDocument()
    await elapse(5_000)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    await act(async () => { finish(outcome === "started" ? { status: "started" } : { status: "error", message: "save failed" }); await Promise.resolve() })
    await elapse(2_600)
    if (outcome === "started") expect(view.getByRole("toolbar", { hidden: true })).not.toHaveAttribute("data-visible")
    else expect(view.getByRole("button", { name: `Retry download ${attachment.name}` })).toBeInTheDocument()
  })

  it("lets automatic mask focus expire but preserves active keyboard control focus", async () => {
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    await position(view.getByTestId(tid.mediaPlayer(attachment.name)), 1, true)
    await click(view.getByRole("button", { name: `Expand ${attachment.name}` }))
    await waitFor(() => expect(view.getByRole("button", { name: `Shrink ${attachment.name}` })).toHaveFocus())
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(player, 0, false)
    await notify(() => fireEvent.loadedData(player))
    const toolbar = view.getByRole("toolbar", { hidden: true })
    await elapse(2_600)
    expect(toolbar).not.toHaveAttribute("data-visible")
    expect(player).toHaveFocus()
    let inertBeforeDefault: boolean | undefined
    player.addEventListener("keydown", () => { inertBeforeDefault = toolbar.hasAttribute("inert") }, { once: true })
    await notify(() => fireEvent.keyDown(player, { key: "Tab" }))
    expect(inertBeforeDefault).toBe(false)
    const shrink = view.getByRole("button", { name: `Shrink ${attachment.name}` })
    act(() => shrink.focus())
    await elapse(5_000)
    expect(toolbar).toHaveAttribute("data-visible")
    act(() => player.focus())
    await elapse(2_600)
    expect(toolbar).not.toHaveAttribute("data-visible")
  })

  it("holds controls during settings and pointer contact, then resumes idle hiding", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(player, 1, false)
    const settings = view.getByRole("button", { name: `Video settings: ${attachment.name}` })
    await click(settings)
    await elapse(5_000)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    expect(view.getByRole("menuitemradio", { name: /1.5/ })).toBeInTheDocument()
    await click(settings)
    await elapse(2_600)
    expect(view.getByRole("toolbar", { hidden: true })).not.toHaveAttribute("data-visible")
    await notify(() => fireEvent.pointerMove(player, { pointerType: "mouse" }))
    const seek = view.getByRole("slider", { name: `Seek ${attachment.name}` })
    mockElementGeometry(seek, { width: 220, height: 44 })
    const seekRoot = view.getByTestId(tid.videoSeek(attachment.name))
    mockElementGeometry(seekRoot, { width: 220, height: 44 })
    Object.assign(seekRoot, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    await notify(() => fireEvent.pointerDown(seek, { pointerType: "mouse", pointerId: 1, button: 0, clientX: 100, clientY: 22, isPrimary: true }))
    await elapse(5_000)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    await notify(() => fireEvent.pointerUp(seekRoot, { pointerType: "mouse", pointerId: 1, button: 0, clientX: 100, clientY: 22, isPrimary: true }))
    await notify(() => fireEvent.lostPointerCapture(seekRoot, { pointerType: "mouse", pointerId: 1 }))
    await elapse(2_600)
    expect(view.getByRole("toolbar", { hidden: true })).not.toHaveAttribute("data-visible")
  })

  it("retires idle timers across Activity and restores paused controls without auto-play", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] })
    function App({ hidden }: { hidden: boolean }) { return <React.Activity mode={hidden ? "hidden" : "visible"}><VideoAttachment attachment={attachment} /></React.Activity> }
    const view = render(<App hidden={false} />)
    views.push(view)
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    await position(player, 2, false)
    await elapse(2_600)
    expect(view.getByRole("toolbar", { hidden: true })).not.toHaveAttribute("data-visible")
    view.rerender(<App hidden />)
    Object.defineProperty(player, "paused", { configurable: true, value: true })
    await elapse(5_000)
    view.rerender(<App hidden={false} />)
    await elapse(5_000)
    expect(view.getByRole("toolbar", { hidden: true })).toHaveAttribute("data-visible")
    expect(play).toHaveBeenCalledOnce()
  })

  it("keeps a blocked player retryable and leaves unsupported video downloadable", async () => {
    play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    const view = mount()
    await click(view.getByTestId(tid.mediaPlay(attachment.name)))
    expect(view.getByRole("alert")).toHaveTextContent("Playback was blocked")
    await click(view.getByTestId(tid.mediaRetry(attachment.name)))
    expect(play).toHaveBeenCalledTimes(2)
    const player = view.getByTestId(tid.mediaPlayer(attachment.name))
    await notify(() => fireEvent.error(player))
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
    if (activated) await position(player, 9, false)
    view.rerender(<App hidden />)
    expect(player).not.toHaveAttribute("src")
    view.rerender(<App hidden={false} />)
    expect(view.getByTestId(id)).toHaveAttribute("src", activated ? attachment.url : `${attachment.url}#t=0`)
    if (activated) {
      await notify(() => fireEvent.loadedMetadata(player))
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
    await notify(() => fireEvent.play(player))
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
    await notify(() => fireEvent.error(view.getByTestId(tid.mediaPlayer(attachment.name))))
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
