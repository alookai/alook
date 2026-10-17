import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import type { FileAttachment } from "@/lib/community/models/message"
import { MediaAttachmentBlock } from "./media-attachment-block"
import { act, fireEvent, type RenderResult } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => React.createElement("button", props, children),
}))

function attachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    kind: "file",
    name: "clip.mp4",
    url: "/attachments/video-1",
    contentType: "video/mp4",
    sizeBytes: 256,
    size: "256 B",
    ...overrides,
  }
}

function attachmentFor(mediaKind: "audio" | "video") {
  return attachment({
    name: mediaKind === "audio" ? "voice.ogg" : "clip.mp4",
    contentType: mediaKind === "audio" ? "audio/ogg" : "video/mp4",
  })
}

function renderMedia({
  item = attachment(),
  mediaKind = "video",
  play = vi.fn().mockResolvedValue(undefined),
  readyState = 4,
}: {
  item?: FileAttachment
  mediaKind?: "audio" | "video"
  play?: ReturnType<typeof vi.fn>
  readyState?: number
} = {}) {
  let currentTime = readyState === 0 ? 0 : 12
  const seek = vi.fn((value: number) => { currentTime = value })
  const pause = vi.fn()
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play)
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause)
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(readyState)
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get")
    .mockImplementation(() => currentTime)
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set")
    .mockImplementation((value) => seek(value))
  const mediaNode = {
    play,
    pause,
    readyState,
    get currentTime() { return currentTime },
  }
  const renderer = render(
    React.createElement(MediaAttachmentBlock, { attachment: item, mediaKind }),
  )
  return { renderer, mediaNode, seek }
}

function byTestId<T extends HTMLElement = HTMLElement>(renderer: RenderResult, testId: string): T {
  return renderer.container.querySelector<T>(`[data-testid="${testId}"]`)!
}

async function clickAndFlush(element: HTMLElement) {
  fireEvent.click(element)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("MediaAttachmentBlock", () => {
  beforeEach(() => {})
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(["audio", "video"] as const)("keeps %s idle with a visible disabled Stop and no mounted media", (mediaKind) => {
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode, seek } = renderMedia({ item, mediaKind })

    expect(renderer.container.querySelectorAll("video, audio")).toHaveLength(0)
    const play = byTestId(renderer, tid.mediaPlay(item.name))
    expect(play).toHaveAttribute("aria-label", `Play ${item.name}`)
    const stop = renderer.getByRole("button", { name: `Stop playback ${item.name}` })
    expect(play.parentElement).toBe(stop.parentElement)
    expect(play.nextElementSibling).toBe(stop)
    expect(renderer.getAllByRole("button", { name: `Stop playback ${item.name}` })).toHaveLength(1)
    expect(stop.nextElementSibling).toBe(byTestId(renderer, tid.mediaDownload(item.name)))
    expect(stop.closest(".aspect-video")).toBeNull()
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    expect(stop).toHaveClass("size-11", "sm:size-8")
    fireEvent.click(stop)
    expect(renderer.container.querySelectorAll("video, audio")).toHaveLength(0)
    expect(mediaNode.play).not.toHaveBeenCalled()
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()
  })

  it.each(["preview", "footer"] as const)("plays video from its %s and uses the footer button for pause and resume", async (entry) => {
    const { renderer, mediaNode } = renderMedia()

    const initialPlay = entry === "preview"
      ? renderer.getByRole("button", { name: "Play video clip.mp4" })
      : byTestId(renderer, tid.mediaPlay("clip.mp4"))
    expect(renderer.queryAllByTestId(tid.mediaPlay("clip.mp4"))).toHaveLength(1)
    await clickAndFlush(initialPlay)

    expect(mediaNode.play).toHaveBeenCalledOnce()
    const player = byTestId<HTMLVideoElement>(renderer, tid.mediaPlayer("clip.mp4"))
    expect(player.tagName).toBe("VIDEO")
    expect(player).toHaveAttribute("src", "/attachments/video-1")
    expect(player).not.toHaveAttribute("controls")
    expect(player).toHaveAttribute("playsinline")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(player).not.toHaveAttribute("autoplay")

    const pause = byTestId(renderer, tid.mediaPlay("clip.mp4"))
    expect(pause).toHaveAttribute("aria-label", "Pause clip.mp4")
    fireEvent.click(pause)
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Play clip.mp4")

    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("keeps the custom button synchronized with native play and pause events", async () => {
    const { renderer } = renderMedia()
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    const player = renderer.container.querySelector("video")!

    fireEvent.pause(player)
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Play clip.mp4")
    expect(byTestId(renderer, tid.mediaCollapse("clip.mp4"))).toBeEnabled()
    fireEvent.play(player)
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Pause clip.mp4")
  })

  it.each(["audio", "video"] as const)("resets %s on natural completion and retains its media and disabled Stop", async (mediaKind) => {
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode } = renderMedia({ item, mediaKind })
    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))
    const retainedPlayer = renderer.container.querySelector(mediaKind)
    const stop = byTestId(renderer, tid.mediaCollapse(item.name))
    expect(stop).toBeEnabled()

    fireEvent.ended(retainedPlayer!)
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(mediaNode.currentTime).toBe(0)
    expect(renderer.container.querySelector(mediaKind)).toBe(retainedPlayer)
    expect(byTestId(renderer, tid.mediaCollapse(item.name))).toBe(stop)
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    expect(byTestId(renderer, tid.mediaPlay(item.name)))
      .toHaveAttribute("aria-label", `Play ${item.name}`)

    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))
    expect(renderer.container.querySelectorAll(mediaKind)).toHaveLength(1)
    expect(renderer.container.querySelector(mediaKind)).toBe(retainedPlayer)
    expect(stop).toBeEnabled()
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("plays audio without exposing native UI and keeps every mobile action at least 44px", async () => {
    const audio = attachment({
      name: "voice.ogg",
      url: "/attachments/audio-1",
      contentType: "audio/ogg",
    })
    const { renderer, mediaNode } = renderMedia({ item: audio, mediaKind: "audio" })

    const play = byTestId(renderer, tid.mediaPlay("voice.ogg"))
    expect(play).toHaveClass(
      "size-11",
      "text-muted-foreground",
      "hover:text-foreground",
      "focus-visible:text-foreground",
    )
    await clickAndFlush(play)

    expect(mediaNode.play).toHaveBeenCalledOnce()
    const player = byTestId<HTMLAudioElement>(renderer, tid.mediaPlayer("voice.ogg"))
    expect(player.tagName).toBe("AUDIO")
    expect(player).not.toHaveAttribute("controls")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(player).not.toHaveAttribute("autoplay")
    expect(player).toHaveClass("hidden")
    expect(player).not.toHaveAttribute("playsinline")
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg"))).toHaveClass("size-11")
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg")))
      .toHaveAttribute("aria-label", "Stop playback voice.ogg")
    expect(byTestId(renderer, tid.mediaDownload("voice.ogg"))).toHaveClass("size-11")
  })

  it("keeps audio loading feedback inside the existing play button without adding row height", () => {
    const pendingPlay = new Promise<void>(() => {})
    const audio = attachment({ name: "voice.ogg", contentType: "audio/ogg" })
    const { renderer } = renderMedia({ item: audio, mediaKind: "audio", play: vi.fn(() => pendingPlay) })

    const stop = byTestId(renderer, tid.mediaCollapse("voice.ogg"))
    expect(stop).toHaveClass("size-11", "sm:size-8")
    expect(stop).toBeDisabled()
    fireEvent.click(byTestId(renderer, tid.mediaPlay("voice.ogg")))
    const loadingButton = byTestId<HTMLButtonElement>(renderer, tid.mediaPlay("voice.ogg"))
    expect(loadingButton).toHaveAttribute("aria-label", "Loading voice.ogg")
    expect(loadingButton).toHaveAttribute("aria-busy", "true")
    expect(loadingButton).toBeDisabled()
    const status = byTestId(renderer, tid.mediaStatus("voice.ogg"))
    expect(status).toHaveClass("sr-only")
    expect(status.parentElement).toBe(loadingButton)
    expect(renderer.container.querySelectorAll('p[role="status"]')).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg"))).toBe(stop)
    expect(stop).toBeEnabled()
  })

  it.each(["audio", "video"] as const)("stops %s at the beginning and retains its media and disabled Stop", async (mediaKind) => {
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode, seek } = renderMedia({ item, mediaKind })
    const stop = byTestId(renderer, tid.mediaCollapse(item.name))
    const stopParent = stop.parentElement
    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))

    const retainedPlayer = renderer.container.querySelector(mediaKind)
    expect(byTestId(renderer, tid.mediaCollapse(item.name))).toBe(stop)
    expect(stop.parentElement).toBe(stopParent)
    expect(stop).toHaveAttribute("aria-label", `Stop playback ${item.name}`)
    expect(stop).toHaveClass("size-11", "sm:size-8")
    expect(stop.nextElementSibling).toBe(byTestId(renderer, tid.mediaDownload(item.name)))
    const play = byTestId(renderer, tid.mediaPlay(item.name))
    expect(play.parentElement).toBe(stop.parentElement)
    expect(play.nextElementSibling).toBe(stop)
    expect(stop.closest(".aspect-video")).toBeNull()
    expect(stop).toBeEnabled()
    fireEvent.click(stop)
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(mediaNode.currentTime).toBe(0)
    expect(seek).toHaveBeenCalledWith(0)
    expect(renderer.container.querySelector(mediaKind)).toBe(retainedPlayer)
    expect(byTestId(renderer, tid.mediaCollapse(item.name))).toBe(stop)
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    expect(byTestId(renderer, tid.mediaPlay(item.name)))
      .toHaveAttribute("aria-label", `Play ${item.name}`)

    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))
    expect(renderer.container.querySelector(mediaKind)).toBe(retainedPlayer)
    expect(stop).toBeEnabled()
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["audio", "resolve"], ["audio", "reject"], ["video", "resolve"], ["video", "reject"],
  ] as const)("stops %s before metadata and ignores a late play %s", async (mediaKind, outcome) => {
    let resolvePlay!: () => void
    let rejectPlay!: (error: unknown) => void
    const pendingPlay = new Promise<void>((resolve, reject) => { resolvePlay = resolve; rejectPlay = reject })
    const play = vi.fn(() => pendingPlay)
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode, seek } = renderMedia({ item, mediaKind, readyState: 0, play })
    const stop = byTestId(renderer, tid.mediaCollapse(item.name))
    fireEvent.click(byTestId(renderer, tid.mediaPlay(item.name)))
    expect(stop).toBeEnabled()
    const retainedPlayer = renderer.container.querySelector(mediaKind)

    fireEvent.click(stop)
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(seek).not.toHaveBeenCalled()
    expect(mediaNode.currentTime).toBe(0)
    expect(renderer.container.querySelector(mediaKind)).toBe(retainedPlayer)
    expect(renderer.queryAllByTestId(tid.mediaRetry(item.name))).toHaveLength(0)
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    expect(byTestId(renderer, tid.mediaPlay(item.name)))
      .toHaveAttribute("aria-label", `Play ${item.name}`)

    await act(async () => {
      if (outcome === "resolve") resolvePlay()
      else rejectPlay(Object.assign(new Error("play interrupted"), { name: "AbortError" }))
      await Promise.resolve()
    })
    expect(renderer.queryAllByTestId(tid.mediaRetry(item.name))).toHaveLength(0)
    expect(renderer.container.querySelector(mediaKind)).toBe(retainedPlayer)
    expect(byTestId(renderer, tid.mediaCollapse(item.name))).toBe(stop)
    expect(stop).toBeDisabled()
    expect(byTestId(renderer, tid.mediaPlay(item.name)))
      .toHaveAttribute("aria-label", `Play ${item.name}`)
  })

  it.each(["audio", "video"] as const)("keeps %s blocked-play retry and Stop reachable", async (mediaKind) => {
    const blocked = Object.assign(new Error("blocked"), { name: "NotAllowedError" })
    const play = vi.fn().mockRejectedValueOnce(blocked).mockResolvedValueOnce(undefined)
    const item = attachmentFor(mediaKind)
    const { renderer } = renderMedia({ item, mediaKind, play })

    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))
    expect(byTestId(renderer, tid.mediaStatus(item.name)))
      .toHaveTextContent("Playback was blocked — try again")
    expect(byTestId(renderer, tid.mediaPlay(item.name)))
      .toHaveAttribute("aria-label", `Try playing ${item.name}`)
    expect(byTestId(renderer, tid.mediaCollapse(item.name))).toBeEnabled()

    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))
    expect(play).toHaveBeenCalledTimes(2)
    expect(renderer.queryAllByTestId(tid.mediaStatus(item.name))).toHaveLength(0)
  })

  it("shows codec errors and retry remounts and immediately plays", async () => {
    const { renderer, mediaNode } = renderMedia()
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    fireEvent.error(renderer.container.querySelector("video")!)

    expect(renderer.container.querySelectorAll("video")).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaStatus("clip.mp4")))
      .toHaveTextContent("Couldn’t play this file")
    const stop = byTestId(renderer, tid.mediaCollapse("clip.mp4"))
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    fireEvent.click(stop)
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(mediaNode.play).toHaveBeenCalledOnce()
    const retry = byTestId(renderer, tid.mediaRetry("clip.mp4"))
    expect(retry).toHaveAttribute("aria-label", "Retry clip.mp4")
    await clickAndFlush(retry)
    expect(renderer.container.querySelectorAll("video")).toHaveLength(1)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
    expect(byTestId(renderer, tid.mediaCollapse("clip.mp4"))).toBe(stop)
    expect(stop).toBeEnabled()
  })

  it("keeps audio retry reachable after a playback error", async () => {
    const audio = attachment({ name: "voice.mp3", contentType: "audio/mpeg" })
    const { renderer, mediaNode } = renderMedia({ item: audio, mediaKind: "audio" })
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("voice.mp3")))
    fireEvent.error(renderer.container.querySelector("audio")!)
    expect(renderer.container.querySelectorAll("audio")).toHaveLength(0)
    const stop = byTestId(renderer, tid.mediaCollapse("voice.mp3"))
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    fireEvent.click(stop)
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(mediaNode.play).toHaveBeenCalledOnce()

    await clickAndFlush(byTestId(renderer, tid.mediaRetry("voice.mp3")))
    expect(renderer.container.querySelectorAll("audio")).toHaveLength(1)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
    expect(byTestId(renderer, tid.mediaCollapse("voice.mp3"))).toBe(stop)
    expect(stop).toBeEnabled()
  })

  it("downloads the original file through the shared owner without activating playback", async () => {
    const stopPropagation = vi.fn()
    const downloadClick = vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("media bytes")))
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:media"), revokeObjectURL: vi.fn() })
    const { renderer, mediaNode } = renderMedia()

    const click = new MouseEvent("click", { bubbles: true })
    Object.defineProperty(click, "stopPropagation", { value: stopPropagation })
    act(() => byTestId(renderer, tid.mediaDownload("clip.mp4")).dispatchEvent(click))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith("/attachments/video-1", { credentials: "same-origin", signal: expect.any(AbortSignal) })
    expect(downloadClick.mock.contexts[0]).toEqual(expect.objectContaining({ href: "blob:media", download: "clip.mp4" }))
    expect(downloadClick).toHaveBeenCalledOnce()
    expect(renderer.getByRole("status")).toHaveTextContent("Download started")
    expect(mediaNode.play).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll("video")).toHaveLength(0)
  })
})
