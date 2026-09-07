import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import type { FileAttachment } from "@/lib/community/models/message"
import { MediaAttachmentBlock } from "./media-attachment-block"
import { resetAttachmentDownloadsForTest } from "@/lib/community/attachment-download"
import { act, fireEvent, render, type RenderResult } from "@/test/react-dom-harness"

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
  beforeEach(() => resetAttachmentDownloadsForTest())
  afterEach(() => {
    resetAttachmentDownloadsForTest()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("keeps video idle without mounting media and exposes a stable play surface", () => {
    const { renderer, mediaNode } = renderMedia()

    expect(renderer.container.querySelectorAll("video")).toHaveLength(0)
    expect(renderer.container.querySelectorAll("audio")).toHaveLength(0)
    const play = byTestId(renderer, tid.mediaPlay("clip.mp4"))
    expect(play).toHaveAttribute("aria-label", "Play clip.mp4")
    expect(play.parentElement).toHaveClass("aspect-video")
    expect(mediaNode.play).not.toHaveBeenCalled()
  })

  it("plays video on first activation and uses the same custom button for pause and resume", async () => {
    const { renderer, mediaNode } = renderMedia()

    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))

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
    fireEvent.play(player)
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Pause clip.mp4")
  })

  it("resets on natural completion and replays the retained media element", async () => {
    const { renderer, mediaNode } = renderMedia()
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    const retainedPlayer = renderer.container.querySelector("video")

    fireEvent.ended(retainedPlayer!)
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(mediaNode.currentTime).toBe(0)
    expect(renderer.container.querySelector("video")).toBe(retainedPlayer)
    expect(renderer.queryAllByTestId(tid.mediaCollapse("clip.mp4"))).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Play clip.mp4")

    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    expect(renderer.container.querySelectorAll("video")).toHaveLength(1)
    expect(renderer.container.querySelector("video")).toBe(retainedPlayer)
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

    const idleStopSlot = renderer.container.querySelector("[data-media-stop-slot]")!
    expect(idleStopSlot).toHaveClass("size-11", "sm:size-8")
    fireEvent.click(byTestId(renderer, tid.mediaPlay("voice.ogg")))
    const loadingButton = byTestId<HTMLButtonElement>(renderer, tid.mediaPlay("voice.ogg"))
    expect(loadingButton).toHaveAttribute("aria-label", "Loading voice.ogg")
    expect(loadingButton).toHaveAttribute("aria-busy", "true")
    expect(loadingButton).toBeDisabled()
    const status = byTestId(renderer, tid.mediaStatus("voice.ogg"))
    expect(status).toHaveClass("sr-only")
    expect(status.parentElement).toBe(loadingButton)
    expect(renderer.container.querySelectorAll('p[role="status"]')).toHaveLength(0)
    expect(renderer.container.querySelectorAll("[data-media-stop-slot]")).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg"))).toHaveClass("size-11")
  })

  it("stops at the beginning and retains the loaded media element", async () => {
    const { renderer, mediaNode, seek } = renderMedia()
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))

    const retainedPlayer = renderer.container.querySelector("video")
    const stop = byTestId(renderer, tid.mediaCollapse("clip.mp4"))
    expect(stop).toHaveAttribute("aria-label", "Stop playback clip.mp4")
    expect(stop).toHaveClass("size-11", "sm:size-8")
    expect(stop.parentElement).toHaveClass("bottom-2", "left-2", "flex", "gap-2")
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")).parentElement).toBe(stop.parentElement)
    fireEvent.click(stop)
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(mediaNode.currentTime).toBe(0)
    expect(seek).toHaveBeenCalledWith(0)
    expect(renderer.container.querySelector("video")).toBe(retainedPlayer)
    expect(renderer.queryAllByTestId(tid.mediaCollapse("clip.mp4"))).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Play clip.mp4")

    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    expect(renderer.container.querySelector("video")).toBe(retainedPlayer)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("stops safely before metadata exists without attempting an invalid seek", async () => {
    let rejectPlay!: (error: unknown) => void
    const pendingPlay = new Promise<void>((_resolve, reject) => { rejectPlay = reject })
    const play = vi.fn(() => pendingPlay)
    const { renderer, mediaNode, seek } = renderMedia({ readyState: 0, play })
    fireEvent.click(byTestId(renderer, tid.mediaPlay("clip.mp4")))

    fireEvent.click(byTestId(renderer, tid.mediaCollapse("clip.mp4")))
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(seek).not.toHaveBeenCalled()
    expect(mediaNode.currentTime).toBe(0)
    expect(renderer.container.querySelector("video")).toBeInTheDocument()
    expect(renderer.queryAllByTestId(tid.mediaRetry("clip.mp4"))).toHaveLength(0)
    expect(renderer.queryAllByTestId(tid.mediaCollapse("clip.mp4"))).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Play clip.mp4")

    await act(async () => {
      rejectPlay(Object.assign(new Error("play interrupted"), { name: "AbortError" }))
      await Promise.resolve()
    })
    expect(renderer.queryAllByTestId(tid.mediaRetry("clip.mp4"))).toHaveLength(0)
    expect(renderer.container.querySelector("video")).toBeInTheDocument()
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Play clip.mp4")
  })

  it("shows blocked-play feedback and lets the custom button try again", async () => {
    const blocked = Object.assign(new Error("blocked"), { name: "NotAllowedError" })
    const play = vi.fn().mockRejectedValueOnce(blocked).mockResolvedValueOnce(undefined)
    const { renderer } = renderMedia({ play })

    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    expect(byTestId(renderer, tid.mediaStatus("clip.mp4")))
      .toHaveTextContent("Playback was blocked — try again")
    expect(byTestId(renderer, tid.mediaPlay("clip.mp4")))
      .toHaveAttribute("aria-label", "Try playing clip.mp4")

    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    expect(play).toHaveBeenCalledTimes(2)
    expect(renderer.queryAllByTestId(tid.mediaStatus("clip.mp4"))).toHaveLength(0)
  })

  it("shows codec errors and retry remounts and immediately plays", async () => {
    const { renderer, mediaNode } = renderMedia()
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("clip.mp4")))
    fireEvent.error(renderer.container.querySelector("video")!)

    expect(renderer.container.querySelectorAll("video")).toHaveLength(0)
    expect(byTestId(renderer, tid.mediaStatus("clip.mp4")))
      .toHaveTextContent("Couldn’t play this file")
    const retry = byTestId(renderer, tid.mediaRetry("clip.mp4"))
    expect(retry).toHaveAttribute("aria-label", "Retry clip.mp4")
    await clickAndFlush(retry)
    expect(renderer.container.querySelectorAll("video")).toHaveLength(1)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("keeps audio retry reachable after a playback error", async () => {
    const audio = attachment({ name: "voice.mp3", contentType: "audio/mpeg" })
    const { renderer, mediaNode } = renderMedia({ item: audio, mediaKind: "audio" })
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("voice.mp3")))
    fireEvent.error(renderer.container.querySelector("audio")!)
    expect(renderer.container.querySelectorAll("audio")).toHaveLength(0)

    await clickAndFlush(byTestId(renderer, tid.mediaRetry("voice.mp3")))
    expect(renderer.container.querySelectorAll("audio")).toHaveLength(1)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("downloads the original file through the shared owner without activating playback", async () => {
    const stopPropagation = vi.fn()
    const createElement = document.createElement.bind(document)
    const anchor = createElement("a")
    vi.spyOn(anchor, "click").mockImplementation(() => {})
    vi.spyOn(anchor, "remove").mockImplementation(() => {})
    vi.spyOn(document, "createElement").mockImplementation((function createElementMock(
      tagName: string,
      options?: ElementCreationOptions,
    ) {
      return tagName === "a" ? anchor : createElement(tagName, options)
    }) as typeof document.createElement)
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
    expect(fetch).toHaveBeenCalledWith("/attachments/video-1", { credentials: "same-origin" })
    expect(anchor).toEqual(expect.objectContaining({ href: "blob:media", download: "clip.mp4" }))
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(renderer.getByRole("status")).toHaveTextContent("Download started")
    expect(mediaNode.play).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll("video")).toHaveLength(0)
  })
})
