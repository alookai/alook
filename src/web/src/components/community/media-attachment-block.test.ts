import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import type { FileAttachment } from "./_types"
import { MediaAttachmentBlock } from "./media-attachment-block"

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
  onDownload,
  play = vi.fn().mockResolvedValue(undefined),
  readyState = 4,
}: {
  item?: FileAttachment
  mediaKind?: "audio" | "video"
  onDownload?: (url: string, name: string) => void
  play?: ReturnType<typeof vi.fn>
  readyState?: number
} = {}) {
  let currentTime = readyState === 0 ? 0 : 12
  const seek = vi.fn((value: number) => { currentTime = value })
  const mediaNode = {
    play,
    pause: vi.fn(),
    readyState,
    get currentTime() { return currentTime },
    set currentTime(value: number) { seek(value) },
  }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(MediaAttachmentBlock, { attachment: item, mediaKind, onDownload }),
      {
        createNodeMock: (element) => {
          if (element.type !== "audio" && element.type !== "video") return null
          return mediaNode
        },
      },
    )
  })
  return { renderer: renderer!, mediaNode, seek }
}

describe("MediaAttachmentBlock", () => {
  it("keeps video idle without mounting media and exposes a stable play surface", () => {
    const { renderer, mediaNode } = renderMedia()

    expect(renderer.root.findAllByType("video")).toHaveLength(0)
    expect(renderer.root.findAllByType("audio")).toHaveLength(0)
    const play = renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") })
    expect(play.props["aria-label"]).toBe("Play clip.mp4")
    expect(play.parent?.props.className).toContain("aspect-video")
    expect(mediaNode.play).not.toHaveBeenCalled()
  })

  it("plays video on first activation and uses the same custom button for pause and resume", async () => {
    const { renderer, mediaNode } = renderMedia()

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })

    expect(mediaNode.play).toHaveBeenCalledOnce()
    const player = renderer.root.findByProps({ "data-testid": tid.mediaPlayer("clip.mp4") })
    expect(player.type).toBe("video")
    expect(player.props).toMatchObject({
      src: "/attachments/video-1",
      controls: false,
      playsInline: true,
      preload: "metadata",
      autoPlay: false,
    })

    const pause = renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") })
    expect(pause.props["aria-label"]).toBe("Pause clip.mp4")
    act(() => pause.props.onClick())
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Play clip.mp4")

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("keeps the custom button synchronized with native play and pause events", async () => {
    const { renderer } = renderMedia()
    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    const player = renderer.root.findByType("video")

    act(() => player.props.onPause())
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Play clip.mp4")
    act(() => player.props.onPlay())
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Pause clip.mp4")
  })

  it("resets on natural completion and replays the retained media element", async () => {
    const { renderer, mediaNode } = renderMedia()
    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    const retainedPlayer = renderer.root.findByType("video")

    act(() => renderer.root.findByType("video").props.onEnded())
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(mediaNode.currentTime).toBe(0)
    expect(renderer.root.findByType("video")).toBe(retainedPlayer)
    expect(renderer.root.findAllByProps({ "data-testid": tid.mediaCollapse("clip.mp4") })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Play clip.mp4")

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findAllByType("video")).toHaveLength(1)
    expect(renderer.root.findByType("video")).toBe(retainedPlayer)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("plays audio without exposing native UI and keeps every mobile action at least 44px", async () => {
    const audio = attachment({
      name: "voice.ogg",
      url: "/attachments/audio-1",
      contentType: "audio/ogg",
    })
    const { renderer, mediaNode } = renderMedia({ item: audio, mediaKind: "audio" })

    const play = renderer.root.findByProps({ "data-testid": tid.mediaPlay("voice.ogg") })
    expect(play.props.className).toContain("size-11")
    expect(play.props.className).toContain("text-muted-foreground")
    expect(play.props.className).toContain("hover:text-foreground")
    expect(play.props.className).toContain("focus-visible:text-foreground")
    await act(async () => {
      play.props.onClick()
      await Promise.resolve()
    })

    expect(mediaNode.play).toHaveBeenCalledOnce()
    const player = renderer.root.findByProps({ "data-testid": tid.mediaPlayer("voice.ogg") })
    expect(player.type).toBe("audio")
    expect(player.props).toMatchObject({ controls: false, preload: "metadata", autoPlay: false, className: "hidden" })
    expect(player.props.playsInline).toBeUndefined()
    expect(renderer.root.findByProps({ "data-testid": tid.mediaCollapse("voice.ogg") }).props.className)
      .toContain("size-11")
    expect(renderer.root.findByProps({ "data-testid": tid.mediaCollapse("voice.ogg") }).props["aria-label"])
      .toBe("Stop playback voice.ogg")
    expect(renderer.root.findByProps({ "data-testid": tid.mediaDownload("voice.ogg") }).props.className)
      .toContain("size-11")
  })

  it("keeps audio loading feedback inside the existing play button without adding row height", () => {
    const pendingPlay = new Promise<void>(() => {})
    const audio = attachment({ name: "voice.ogg", contentType: "audio/ogg" })
    const { renderer } = renderMedia({ item: audio, mediaKind: "audio", play: vi.fn(() => pendingPlay) })

    const idleStopSlot = renderer.root.findByProps({ "data-media-stop-slot": true })
    expect(idleStopSlot.props.className).toContain("size-11")
    expect(idleStopSlot.props.className).toContain("sm:size-8")
    act(() => renderer.root.findByProps({ "data-testid": tid.mediaPlay("voice.ogg") }).props.onClick())
    const loadingButton = renderer.root.findByProps({ "data-testid": tid.mediaPlay("voice.ogg") })
    expect(loadingButton.props["aria-label"]).toBe("Loading voice.ogg")
    expect(loadingButton.props["aria-busy"]).toBe(true)
    expect(loadingButton.props.disabled).toBe(true)
    const status = renderer.root.findByProps({ "data-testid": tid.mediaStatus("voice.ogg") })
    expect(status.props.className).toBe("sr-only")
    expect(status.parent?.type).toBe("button")
    expect(status.parent?.props["data-testid"]).toBe(tid.mediaPlay("voice.ogg"))
    expect(renderer.root.findAll((node) => node.type === "p" && node.props.role === "status")).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-media-stop-slot": true })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.mediaCollapse("voice.ogg") }).props.className)
      .toContain("size-11")
  })

  it("stops at the beginning and retains the loaded media element", async () => {
    const { renderer, mediaNode, seek } = renderMedia()
    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })

    const retainedPlayer = renderer.root.findByType("video")
    const stop = renderer.root.findByProps({ "data-testid": tid.mediaCollapse("clip.mp4") })
    expect(stop.props["aria-label"]).toBe("Stop playback clip.mp4")
    expect(stop.props.className).toContain("size-11")
    expect(stop.props.className).toContain("sm:size-8")
    expect(stop.parent?.props.className).toContain("bottom-2 left-2 flex gap-2")
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).parent).toBe(stop.parent)
    act(() => stop.props.onClick())
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(mediaNode.currentTime).toBe(0)
    expect(seek).toHaveBeenCalledWith(0)
    expect(renderer.root.findByType("video")).toBe(retainedPlayer)
    expect(renderer.root.findAllByProps({ "data-testid": tid.mediaCollapse("clip.mp4") })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Play clip.mp4")

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findByType("video")).toBe(retainedPlayer)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("stops safely before metadata exists without attempting an invalid seek", async () => {
    let rejectPlay!: (error: unknown) => void
    const pendingPlay = new Promise<void>((_resolve, reject) => { rejectPlay = reject })
    const play = vi.fn(() => pendingPlay)
    const { renderer, mediaNode, seek } = renderMedia({ readyState: 0, play })
    act(() => renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick())

    act(() => renderer.root.findByProps({ "data-testid": tid.mediaCollapse("clip.mp4") }).props.onClick())
    expect(mediaNode.pause).toHaveBeenCalledOnce()
    expect(seek).not.toHaveBeenCalled()
    expect(mediaNode.currentTime).toBe(0)
    expect(renderer.root.findByType("video")).toBeDefined()
    expect(renderer.root.findAllByProps({ "data-testid": tid.mediaRetry("clip.mp4") })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ "data-testid": tid.mediaCollapse("clip.mp4") })).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Play clip.mp4")

    await act(async () => {
      rejectPlay(Object.assign(new Error("play interrupted"), { name: "AbortError" }))
      await Promise.resolve()
    })
    expect(renderer.root.findAllByProps({ "data-testid": tid.mediaRetry("clip.mp4") })).toHaveLength(0)
    expect(renderer.root.findByType("video")).toBeDefined()
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Play clip.mp4")
  })

  it("shows blocked-play feedback and lets the custom button try again", async () => {
    const blocked = Object.assign(new Error("blocked"), { name: "NotAllowedError" })
    const play = vi.fn().mockRejectedValueOnce(blocked).mockResolvedValueOnce(undefined)
    const { renderer } = renderMedia({ play })

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ "data-testid": tid.mediaStatus("clip.mp4") }).children)
      .toEqual(["Playback was blocked — try again"])
    expect(renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props["aria-label"])
      .toBe("Try playing clip.mp4")

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    expect(play).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByProps({ "data-testid": tid.mediaStatus("clip.mp4") })).toHaveLength(0)
  })

  it("shows codec errors and retry remounts and immediately plays", async () => {
    const { renderer, mediaNode } = renderMedia()
    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick()
      await Promise.resolve()
    })
    act(() => renderer.root.findByType("video").props.onError())

    expect(renderer.root.findAllByType("video")).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": tid.mediaStatus("clip.mp4") }).children)
      .toEqual(["Couldn’t play this file"])
    const retry = renderer.root.findByProps({ "data-testid": tid.mediaRetry("clip.mp4") })
    expect(retry.props["aria-label"]).toBe("Retry clip.mp4")
    await act(async () => {
      retry.props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findAllByType("video")).toHaveLength(1)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("keeps audio retry reachable after a playback error", async () => {
    const audio = attachment({ name: "voice.mp3", contentType: "audio/mpeg" })
    const { renderer, mediaNode } = renderMedia({ item: audio, mediaKind: "audio" })
    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaPlay("voice.mp3") }).props.onClick()
      await Promise.resolve()
    })
    act(() => renderer.root.findByType("audio").props.onError())
    expect(renderer.root.findAllByType("audio")).toHaveLength(0)

    await act(async () => {
      renderer.root.findByProps({ "data-testid": tid.mediaRetry("voice.mp3") }).props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findAllByType("audio")).toHaveLength(1)
    expect(mediaNode.play).toHaveBeenCalledTimes(2)
  })

  it("downloads the original file without activating playback", () => {
    const onDownload = vi.fn()
    const stopPropagation = vi.fn()
    const { renderer, mediaNode } = renderMedia({ onDownload })

    act(() => renderer.root.findByProps({ "data-testid": tid.mediaDownload("clip.mp4") }).props.onClick({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onDownload).toHaveBeenCalledWith("/attachments/video-1", "clip.mp4")
    expect(mediaNode.play).not.toHaveBeenCalled()
    expect(renderer.root.findAllByType("video")).toHaveLength(0)
  })
})
