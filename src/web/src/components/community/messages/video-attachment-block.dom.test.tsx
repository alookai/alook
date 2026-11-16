import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { VideoAttachmentBlock } from "./video-attachment-block"
import type { FileAttachment } from "@/lib/community/models/message"

const attachment: FileAttachment = { kind: "file", name: "clip.mp4", url: "/attachments/clip", contentType: "video/mp4", size: "1 KB", sizeBytes: 1024 }
let play = vi.fn<() => Promise<void>>()
let pause = vi.fn<() => void>()
const mounted: Array<ReturnType<typeof render>> = []
const popoverDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "popover")
const audioTracksDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "audioTracks")
const styles: HTMLStyleElement[] = []

beforeEach(() => {
  play = vi.fn(function(this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false })
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  })
  pause = vi.fn(function(this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true })
    this.dispatchEvent(new Event("pause"))
  })
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause)
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
})

afterEach(() => {
  for (const screen of mounted.splice(0)) screen.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const style of styles.splice(0)) style.parentNode?.removeChild(style)
  if (popoverDescriptor) Object.defineProperty(HTMLElement.prototype, "popover", popoverDescriptor)
  if (audioTracksDescriptor) Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", audioTracksDescriptor)
})

function setup() {
  const screen = render(<VideoAttachmentBlock attachment={attachment} />)
  mounted.push(screen)
  const video = screen.container.querySelector("video")!
  return { screen, video }
}

function metadata(video: HTMLVideoElement, duration = 10) {
  Object.defineProperties(video, {
    duration: { configurable: true, value: duration },
    readyState: { configurable: true, value: 4 },
    videoWidth: { configurable: true, value: 640 },
    videoHeight: { configurable: true, value: 480 },
  })
  fireEvent.loadedMetadata(video)
}

function fallbackMenus() {
  vi.stubGlobal("CSS", { ...CSS, supports: () => false })
  Reflect.deleteProperty(HTMLElement.prototype, "popover")
  Reflect.deleteProperty(HTMLMediaElement.prototype, "audioTracks")
  const style = document.createElement("style")
  style.textContent = ".media-popup[data-open] { display: block !important }"
  document.head.appendChild(style)
  styles.push(style)
}

describe("video attachment", () => {
  it.each([[10, 0.1], [0.05, 0.025]])("shows a paused frame for duration %s without starting playback", (duration, time) => {
    const { screen, video } = setup()
    metadata(video, duration)
    expect(video.currentTime).toBe(time)
    fireEvent.seeked(video)
    expect(video.paused).toBe(true)
    expect(play).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Play video clip.mp4" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Expand video" })).toBeNull()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.container.querySelector("img")).toBeNull()
  })

  it("does not overwrite an early user play or a later seek when metadata repeats", async () => {
    const { screen, video } = setup()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    video.currentTime = 3
    metadata(video)
    expect(video.currentTime).toBe(3)
    expect(play).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Expand video" })).toBeInTheDocument()
  })

  it("keeps the same player and settings across mask and inline placement", async () => {
    const { screen, video } = setup()
    metadata(video)
    fireEvent.seeked(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    video.currentTime = 4
    video.volume = 0.4
    video.playbackRate = 1.25
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Expand video" })))
    expect(document.querySelector('[role="dialog"] video')).toBe(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Shrink video" })))
    expect(screen.container.querySelector("article video")).toBe(video)
    expect(video.currentTime).toBe(4)
    expect(video.volume).toBe(0.4)
    expect(video.playbackRate).toBe(1.25)
    expect(pause).not.toHaveBeenCalled()
  })

  it("offers a fresh preview after media error and retires the failed node", async () => {
    const { screen, video } = setup()
    fireEvent.error(video)
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t play this file")
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry clip.mp4" })))
    const replacement = screen.container.querySelector("video")!
    expect(replacement).not.toBe(video)
    expect(video.getAttribute("src")).toBeNull()
    expect(pause).toHaveBeenCalled()
    metadata(replacement)
    expect(replacement.currentTime).toBe(0.1)
    expect(play).not.toHaveBeenCalled()
  })

  it("allows a blocked user play to be retried without replacing the video", async () => {
    play.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
    const { screen, video } = setup()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    expect(screen.getByRole("alert")).toHaveTextContent("Playback was blocked")
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try playing clip.mp4" })))
    expect(play).toHaveBeenCalledTimes(2)
    expect(screen.container.querySelector("video")).toBe(video)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("releases the source on unmount and ignores a late rejected play", async () => {
    let reject!: (reason: Error) => void
    play.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
    const { screen, video } = setup()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    screen.unmount()
    expect(video.getAttribute("src")).toBeNull()
    expect(pause).toHaveBeenCalled()
    await act(async () => reject(new Error("late")))
    expect(document.querySelector("video")).toBeNull()
  })

  it("retires a replaced attachment and starts its own paused preview", () => {
    const { screen, video } = setup()
    metadata(video)
    screen.rerender(<VideoAttachmentBlock attachment={{ ...attachment, url: "/attachments/second" }} />)
    const replacement = screen.container.querySelector("video")!
    expect(replacement).not.toBe(video)
    expect(video.getAttribute("src")).toBeNull()
    expect(replacement.getAttribute("src")).toBe("/attachments/second")
    metadata(replacement)
    expect(replacement.currentTime).toBe(0.1)
    expect(play).not.toHaveBeenCalled()
  })

  it("keeps a failed download visible after the fallback menu closes and allows retry", async () => {
    fallbackMenus()
    const fetch = vi.fn().mockRejectedValue(new Error("offline"))
    vi.stubGlobal("fetch", fetch)
    const { screen, video } = setup()
    metadata(video)
    fireEvent.seeked(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "More" })))
    const download = await screen.findByRole("menuitem", { name: "Download" })
    await act(async () => fireEvent.click(download))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t save — retry"))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(fetch).toHaveBeenCalledWith(attachment.url, { credentials: "same-origin", signal: expect.any(AbortSignal) })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "More" })))
    const retryDownload = await screen.findByRole("menuitem", { name: "Retry download" })
    await act(async () => fireEvent.click(retryDownload))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("opens speed choices from More and returns to Download before selecting a rate", async () => {
    fallbackMenus()
    const { screen, video } = setup()
    metadata(video)
    fireEvent.seeked(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "More" })))
    const download = await screen.findByRole("menuitem", { name: "Download" })
    const speed = screen.getByRole("menuitem", { name: /^Speed/ })
    expect(download.compareDocumentPosition(speed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole("menuitemradio")).toBeNull()
    await act(async () => fireEvent.click(speed))
    await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(7))
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Back to More" })))
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeVisible()
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /^Speed/ })))
    await act(async () => fireEvent.click(screen.getByRole("menuitemradio", { name: "1.5×" })))
    await waitFor(() => expect(video.playbackRate).toBe(1.5))
    expect(screen.getByRole("menu", { name: "More" })).toBeVisible()
    expect(screen.getByRole("menuitem", { name: /^Speed/ })).toHaveTextContent("1.5×")
  })
})
