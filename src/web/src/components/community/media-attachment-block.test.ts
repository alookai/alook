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

describe("MediaAttachmentBlock", () => {
  it("keeps video idle without mounting media and exposes a stable play surface", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MediaAttachmentBlock, {
        attachment: attachment(),
        mediaKind: "video",
      }))
    })

    expect(renderer!.root.findAllByType("video")).toHaveLength(0)
    expect(renderer!.root.findAllByType("audio")).toHaveLength(0)
    const play = renderer!.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") })
    expect(play.props["aria-label"]).toBe("Play clip.mp4")
    expect(play.parent?.props.className).toContain("aspect-video")
  })

  it("mounts a non-autoplay metadata video only after activation and unmounts on collapse", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MediaAttachmentBlock, {
        attachment: attachment(),
        mediaKind: "video",
      }))
    })

    act(() => renderer!.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick())
    const player = renderer!.root.findByProps({ "data-testid": tid.mediaPlayer("clip.mp4") })
    expect(player.type).toBe("video")
    expect(player.props).toMatchObject({
      src: "/attachments/video-1",
      controls: true,
      playsInline: true,
      preload: "metadata",
      autoPlay: false,
    })
    expect(renderer!.root.findByProps({ "data-testid": tid.mediaStatus("clip.mp4") }).children)
      .toEqual(["Loading media…"])

    act(() => player.props.onLoadedMetadata())
    expect(renderer!.root.findAllByProps({ "data-testid": tid.mediaStatus("clip.mp4") })).toHaveLength(0)
    act(() => renderer!.root.findByProps({ "data-testid": tid.mediaCollapse("clip.mp4") }).props.onClick())
    expect(renderer!.root.findAllByType("video")).toHaveLength(0)
  })

  it("mounts compact audio controls and keeps mobile actions at least 44px", () => {
    const audio = attachment({
      name: "voice.ogg",
      url: "/attachments/audio-1",
      contentType: "audio/ogg",
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MediaAttachmentBlock, {
        attachment: audio,
        mediaKind: "audio",
      }))
    })

    const play = renderer!.root.findByProps({ "data-testid": tid.mediaPlay("voice.ogg") })
    expect(play.props.className).toContain("size-11")
    act(() => play.props.onClick())
    const player = renderer!.root.findByProps({ "data-testid": tid.mediaPlayer("voice.ogg") })
    expect(player.type).toBe("audio")
    expect(player.props).toMatchObject({ controls: true, preload: "metadata", autoPlay: false })
    expect(player.props.playsInline).toBeUndefined()
    expect(renderer!.root.findByProps({ "data-testid": tid.mediaCollapse("voice.ogg") }).props.className)
      .toContain("size-11")
    expect(renderer!.root.findByProps({ "data-testid": tid.mediaDownload("voice.ogg") }).props.className)
      .toContain("size-11")
  })

  it("shows a bounded error state and retry remounts the player", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MediaAttachmentBlock, {
        attachment: attachment(),
        mediaKind: "video",
      }))
    })

    act(() => renderer!.root.findByProps({ "data-testid": tid.mediaPlay("clip.mp4") }).props.onClick())
    act(() => renderer!.root.findByType("video").props.onError())
    expect(renderer!.root.findAllByType("video")).toHaveLength(0)
    expect(renderer!.root.findByProps({ "data-testid": tid.mediaStatus("clip.mp4") }).children)
      .toEqual(["Couldn’t play this file"])
    const retry = renderer!.root.findByProps({ "data-testid": tid.mediaRetry("clip.mp4") })
    expect(retry.props["aria-label"]).toBe("Retry clip.mp4")
    act(() => retry.props.onClick())
    expect(renderer!.root.findAllByType("video")).toHaveLength(1)
  })

  it("keeps audio retry reachable after a playback error", () => {
    const audio = attachment({ name: "voice.mp3", contentType: "audio/mpeg" })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MediaAttachmentBlock, {
        attachment: audio,
        mediaKind: "audio",
      }))
    })

    act(() => renderer!.root.findByProps({ "data-testid": tid.mediaPlay("voice.mp3") }).props.onClick())
    act(() => renderer!.root.findByType("audio").props.onError())
    expect(renderer!.root.findAllByType("audio")).toHaveLength(0)
    const retry = renderer!.root.findByProps({ "data-testid": tid.mediaRetry("voice.mp3") })
    act(() => retry.props.onClick())
    expect(renderer!.root.findAllByType("audio")).toHaveLength(1)
  })

  it("downloads the original file without activating playback", () => {
    const onDownload = vi.fn()
    const stopPropagation = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(MediaAttachmentBlock, {
        attachment: attachment(),
        mediaKind: "video",
        onDownload,
      }))
    })

    act(() => renderer!.root.findByProps({ "data-testid": tid.mediaDownload("clip.mp4") }).props.onClick({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onDownload).toHaveBeenCalledWith("/attachments/video-1", "clip.mp4")
    expect(renderer!.root.findAllByType("video")).toHaveLength(0)
  })
})
