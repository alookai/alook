import React from "react"
import "fake-indexeddb/auto"
import { Blob as NativeBlob } from "node:buffer"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { VideoAttachmentBlock } from "./video-attachment-block"
import { Message } from "./message"
import { requestNativeBack } from "@/components/ui/native-back-layer"
import type { FileAttachment } from "@/lib/community/models/message"
import { createIdbPersister, clearAllPersistedCaches } from "@/lib/query-persister"
import { captureVideoPreviewOwner, readVideoPreview, saveVideoPreview } from "@/lib/community/video-preview-cache"
import * as previewCache from "@/lib/community/video-preview-cache"
import { keys } from "idb-keyval"
import { cacheStore } from "@/lib/query-cache-store"

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

function setupMessage() {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} })
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} unobserve() {} })
  const onReply = vi.fn()
  const screen = render(<Message m={{ id: "video-message", type: "chat", authorId: "author", authorName: "Alice",
    content: "Video controls in a message", createdAt: new Date(0).toISOString(), grouped: false, attachments: [attachment] }}
    hoverCapable={false} onReply={onReply} onCopy={vi.fn()} onOpenThread={vi.fn()} />)
  mounted.push(screen)
  return { screen, video: screen.container.querySelector("video")!, onReply }
}

async function touchTap(target: HTMLElement) {
  await act(async () => {
    const pointer = { pointerType: "touch", pointerId: 17, button: 0, clientX: 80, clientY: 100 }
    fireEvent.pointerDown(target, pointer)
    fireEvent.touchStart(target)
    fireEvent.pointerUp(target, pointer)
    fireEvent.touchEnd(target)
    fireEvent.click(target, { button: 0, clientX: 80, clientY: 100 })
  })
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

function previewPlatform() {
  vi.stubGlobal("Blob", NativeBlob)
  const revoke = vi.fn()
  const create = vi.fn(() => "blob:restored-video-preview")
  const OriginalURL = URL
  vi.stubGlobal("URL", class extends OriginalURL {
    static createObjectURL = create
    static revokeObjectURL = revoke
  })
  return { create, revoke }
}

async function previewOwner(source: string) {
  await clearAllPersistedCaches()
  const persister = createIdbPersister("viewer")
  await persister.rememberAccountIdentity({ id: "viewer", email: "viewer@example.test" }, () => {})
  const owner = await captureVideoPreviewOwner("viewer", source)
  if (!owner) throw new Error("Preview fixture has no qualified current account")
  return { owner, persister }
}

const cachedAttachment: FileAttachment = { ...attachment, id: "preview-clip", url: "/api/community/channels/preview-channel/attachments/preview-clip" }

describe("video attachment", () => {
  it("keeps the expanded bar and before-start skin usable through idle, error and retry", async () => {
    const style = document.createElement("style")
    style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "video-attachment.css"), "utf8")
    document.head.appendChild(style); styles.push(style)
    const { screen, video } = setup()
    metadata(video); fireEvent.seeked(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Expand video" })))
    const toolbar = screen.getByRole("toolbar", { name: "Video controls" })
    const player = video.closest<HTMLElement>(".alook-video-player")!
    fireEvent.pointerLeave(player)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)) })
    expect(player).toHaveAttribute("data-controls-visible")
    expect(toolbar).toHaveAttribute("data-visible")
    expect(getComputedStyle(player).getPropertyValue("--media-controls-before-start").trim()).toBe("visible")
    fireEvent.error(video)
    expect(screen.getByRole("toolbar")).toBe(toolbar)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry clip.mp4" })))
    const replacement = document.querySelector<HTMLVideoElement>('video')!
    expect(replacement).not.toBe(video)
    expect(document.querySelectorAll("video")).toHaveLength(1)
    expect(screen.getByRole("toolbar")).toBe(toolbar)
    expect(toolbar).not.toHaveAttribute("data-started")
    expect(toolbar).toHaveAttribute("data-visible")
    expect(toolbar.closest("[inert]")).toBeNull()
    expect(getComputedStyle(toolbar).visibility).toBe("visible")
    expect(getComputedStyle(toolbar).opacity).toBe("1")
    expect(getComputedStyle(toolbar).pointerEvents).toBe("auto")
    expect(screen.getByRole("button", { name: "More" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Shrink video" })).toBeEnabled()
    metadata(replacement); fireEvent.seeked(replacement)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Shrink video" })))
    expect(screen.queryByRole("toolbar")).toBeNull()
    expect(screen.getByRole("button", { name: "Play video clip.mp4" })).toBeVisible()
    expect(getComputedStyle(player).getPropertyValue("--media-controls-before-start").trim()).toBe("")
  })

  it("captures from the original paused video, commits, and restores a Blob poster in a new UI owner", async () => {
    const platform = previewPlatform()
    const { owner, persister } = await previewOwner(cachedAttachment.url)
    const draw = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
      queueMicrotask(() => callback(new Blob([new Uint8Array([255, 216, 255, 224, 1, 2, 3])], { type: "image/jpeg" })))
    })
    const first = render(<VideoAttachmentBlock attachment={cachedAttachment} />); mounted.push(first)
    const video = first.container.querySelector("video")!
    await waitFor(() => expect(video.preload).toBe("metadata"))
    metadata(video); fireEvent.seeked(video)
    await waitFor(async () => expect((await readVideoPreview(owner, cachedAttachment.url))?.poster).toBeInstanceOf(Blob))
    expect(draw).toHaveBeenCalledExactlyOnceWith(video, 0, 0, 640, 480)
    expect(play).not.toHaveBeenCalled()
    first.unmount()
    const second = render(<VideoAttachmentBlock attachment={cachedAttachment} />); mounted.push(second)
    const restored = second.container.querySelector("video")!
    await waitFor(() => expect(restored.poster).toBe("blob:restored-video-preview"))
    expect(restored.preload).toBe("none")
    expect(second.container.querySelector("article")?.style.aspectRatio).toBe("640/480")
    metadata(restored)
    expect(restored.currentTime).toBe(0)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(platform.create).toHaveBeenCalledTimes(1)
    second.unmount()
    expect(platform.revoke).toHaveBeenCalledExactlyOnceWith("blob:restored-video-preview")
    persister.stopPersisting()
  })

  it("does not capture a later playing frame or rewind an early user play for the cache", async () => {
    previewPlatform()
    const { owner, persister } = await previewOwner(cachedAttachment.url)
    const draw = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D)
    const screen = render(<VideoAttachmentBlock attachment={cachedAttachment} />); mounted.push(screen)
    const video = screen.container.querySelector("video")!
    await waitFor(() => expect(video.preload).toBe("metadata"))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    video.currentTime = 3
    metadata(video); fireEvent.seeked(video)
    await waitFor(async () => expect(await readVideoPreview(owner, cachedAttachment.url)).toMatchObject({ width: 640, height: 480 }))
    expect((await readVideoPreview(owner, cachedAttachment.url))?.poster).toBeUndefined()
    expect(draw).not.toHaveBeenCalled()
    expect(video.currentTime).toBe(3)
    expect(play).toHaveBeenCalledTimes(1)
    persister.stopPersisting()
  })

  it("cannot repopulate cleared storage when an already captured JPEG completes late", async () => {
    previewPlatform()
    const { persister } = await previewOwner(cachedAttachment.url)
    const saving = vi.spyOn(previewCache, "saveVideoPreview")
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    let finish: BlobCallback | undefined
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => { finish = callback })
    const screen = render(<VideoAttachmentBlock attachment={cachedAttachment} />); mounted.push(screen)
    const video = screen.container.querySelector("video")!
    await waitFor(() => expect(video.preload).toBe("metadata"))
    metadata(video); fireEvent.seeked(video)
    await waitFor(() => expect(finish).toBeDefined())
    await waitFor(() => expect(saving).toHaveBeenCalledTimes(1))
    await clearAllPersistedCaches()
    await act(async () => finish!(new Blob([new Uint8Array([255, 216, 255, 224])], { type: "image/jpeg" })))
    await waitFor(() => expect(saving).toHaveBeenCalledTimes(2))
    expect(await saving.mock.results[1]!.value).toBe(false)
    expect((await keys(cacheStore)).filter(key => previewCache.isVideoPreviewCacheKey(key))).toHaveLength(0)
    expect(play).not.toHaveBeenCalled()
    persister.stopPersisting()
  })
  it("keeps touch menu actions local while ordinary message body taps still open its menu", async () => {
    fallbackMenus()
    const fetch = vi.fn().mockRejectedValue(new Error("offline"))
    vi.stubGlobal("fetch", fetch)
    const { screen, video } = setupMessage()
    metadata(video)
    fireEvent.seeked(video)
    await touchTap(screen.getByRole("button", { name: "Play video clip.mp4" }))
    await touchTap(screen.getByRole("button", { name: "More" }))
    await touchTap(await screen.findByRole("menuitem", { name: /^Speed/ }))
    expect(document.querySelector("[data-message-touch-menu][data-open]")).toBeNull()
    const rate = await screen.findByRole("menuitemradio", { name: "1.5×" })
    await touchTap(rate)
    await waitFor(() => expect(video.playbackRate).toBe(1.5))
    expect(document.querySelector("[data-message-touch-menu][data-open]")).toBeNull()
    await touchTap(screen.getByRole("menuitem", { name: "Download" }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(attachment.url, { credentials: "same-origin", signal: expect.any(AbortSignal) }))
    expect(document.querySelector("[data-message-touch-menu][data-open]")).toBeNull()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await touchTap(screen.getByText("Video controls in a message", { exact: true }))
    await waitFor(() => expect(document.querySelector("[data-message-touch-menu][data-open]")).not.toBeNull())
    expect(screen.getByRole("menuitem", { name: "Reply" })).toBeVisible()
    expect(play).toHaveBeenCalledTimes(1)
  })

  it("does not start message reply swiping from a video menu item", async () => {
    fallbackMenus()
    const { screen, video, onReply } = setupMessage()
    metadata(video)
    await touchTap(screen.getByRole("button", { name: "Play video clip.mp4" }))
    await touchTap(screen.getByRole("button", { name: "More" }))
    const speed = await screen.findByRole("menuitem", { name: /^Speed/ })
    await act(async () => {
      fireEvent.pointerDown(speed, { pointerType: "touch", pointerId: 2, clientX: 80, clientY: 100 })
      fireEvent.pointerMove(speed, { pointerType: "touch", pointerId: 2, clientX: 148, clientY: 102 })
      fireEvent.pointerUp(speed, { pointerType: "touch", pointerId: 2, clientX: 148, clientY: 102 })
    })
    expect(onReply).not.toHaveBeenCalled()
  })

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

  it("preserves a new menu focus while the previous mask finishes leaving", async () => {
    fallbackMenus()
    const { screen, video } = setup()
    metadata(video)
    fireEvent.seeked(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Expand video" })))
    const mask = screen.getByRole("dialog", { name: attachment.name })
    await waitFor(() => expect(mask).not.toHaveAttribute("data-starting-style"))
    let finishExit!: () => void
    const finished = new Promise<void>(resolve => { finishExit = resolve })
    Object.defineProperty(mask, "getAnimations", { configurable: true, value: () => [{ finished }] })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Shrink video" })))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "More" })))
    const download = await screen.findByRole("menuitem", { name: "Download" })
    await act(async () => download.focus())
    expect(download).toHaveFocus()
    await act(async () => finishExit())
    await waitFor(() => expect(mask).not.toBeInTheDocument())
    expect(download).toHaveFocus()
    expect(screen.getByRole("menu", { name: "More" })).toBeVisible()
    expect(screen.container.querySelector("article video")).toBe(video)
    expect(pause).not.toHaveBeenCalled()
  })

  it.each(["Escape", "native back"])("dismisses Speed, More and the mask in order with %s", async method => {
    fallbackMenus()
    const { screen, video } = setup()
    metadata(video)
    fireEvent.seeked(video)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play video clip.mp4" })))
    video.currentTime = 4
    video.playbackRate = 1.25
    video.volume = 0.4
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Expand video" })))
    const mask = screen.getByRole("dialog", { name: attachment.name })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "More" })))
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: /^Speed/ })))
    const rate = await screen.findByRole("menuitemradio", { name: "1.25×" })
    await act(async () => rate.focus())
    const dismiss = async () => act(async () => {
      if (method === "native back") expect(requestNativeBack(document)).toBe("requested")
      else fireEvent.keyDown(document.activeElement!, { key: "Escape", code: "Escape" })
    })
    await dismiss()
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Playback speed" })).toBeNull())
    expect(screen.getByRole("menu", { name: "More" })).toBeVisible()
    expect(mask).toHaveAttribute("data-open")
    await dismiss()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(mask).toHaveAttribute("data-open")
    await dismiss()
    await waitFor(() => expect(mask).not.toBeInTheDocument())
    expect(screen.container.querySelector("article video")).toBe(video)
    expect(video.currentTime).toBe(4)
    expect(video.playbackRate).toBe(1.25)
    expect(video.volume).toBe(0.4)
    expect(pause).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Expand video" })).toHaveFocus()
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

  it("synchronously restores cached video dimensions on remount under the same registry", () => {
    const view = render(<VideoAttachmentBlock attachment={cachedAttachment} />)
    mounted.push(view)
    const video = view.container.querySelector("video")!
    metadata(video)
    expect(view.container.querySelector("article")?.style.aspectRatio).toBe("640/480")

    view.rerender(<div />)
    view.rerender(<VideoAttachmentBlock attachment={cachedAttachment} />)
    expect(view.container.querySelector("article")?.style.aspectRatio).toBe("640/480")
  })
})
