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
    name: "voice.ogg",
    url: "/attachments/video-1",
    contentType: "audio/ogg",
    sizeBytes: 256,
    size: "256 B",
    ...overrides,
  }
}

function attachmentFor(mediaKind: "audio" | "video") {
  return attachment({
    name: mediaKind === "audio" ? "voice.ogg" : "voice.ogg",
    contentType: mediaKind === "audio" ? "audio/ogg" : "audio/ogg",
  })
}

function renderMedia({
  item = attachment(),
  mediaKind = "audio",
  play = vi.fn().mockResolvedValue(undefined),
  readyState = 4,
}: {
  item?: FileAttachment
  mediaKind?: "audio"
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

  it.each(["audio"] as const)("keeps %s idle with a visible disabled Stop and no mounted media", (mediaKind) => {
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode, seek } = renderMedia({ item, mediaKind })

    expect(renderer.container.querySelectorAll("video, audio")).toHaveLength(0)
    const play = byTestId(renderer, tid.mediaPlay(item.name))
    expect(play).toHaveAttribute("aria-label", `Play ${item.name}`)
    const stop = renderer.getByRole("button", { name: `Stop playback ${item.name}` })
    expect(renderer.getAllByRole("button", { name: `Stop playback ${item.name}` })).toHaveLength(1)
    expect(stop).toBeVisible()
    expect(stop).toBeDisabled()
    fireEvent.click(stop)
    expect(renderer.container.querySelectorAll("video, audio")).toHaveLength(0)
    expect(mediaNode.play).not.toHaveBeenCalled()
    expect(mediaNode.pause).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()
  })

  it("keeps the custom button synchronized with native play and pause events", async () => {
    const { renderer } = renderMedia()
    await clickAndFlush(byTestId(renderer, tid.mediaPlay("voice.ogg")))
    const player = renderer.container.querySelector("audio")!

    fireEvent.pause(player)
    expect(byTestId(renderer, tid.mediaPlay("voice.ogg")))
      .toHaveAttribute("aria-label", "Play voice.ogg")
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg"))).toBeEnabled()
    fireEvent.play(player)
    expect(byTestId(renderer, tid.mediaPlay("voice.ogg")))
      .toHaveAttribute("aria-label", "Pause voice.ogg")
  })

  it.each(["audio"] as const)("resets %s on natural completion and retains its media and disabled Stop", async (mediaKind) => {
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode } = renderMedia({ item, mediaKind })
    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))
    const retainedPlayer = renderer.container.querySelector(mediaKind)
    const stop = byTestId(renderer, tid.mediaCollapse(item.name))
    expect(stop).toBeEnabled()

    fireEvent.ended(retainedPlayer!)
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

  it("plays audio through its custom controls without requesting native controls", async () => {
    const audio = attachment({
      name: "voice.ogg",
      url: "/attachments/audio-1",
      contentType: "audio/ogg",
    })
    const { renderer, mediaNode } = renderMedia({ item: audio, mediaKind: "audio" })

    const play = byTestId(renderer, tid.mediaPlay("voice.ogg"))
    await clickAndFlush(play)

    expect(mediaNode.play).toHaveBeenCalledOnce()
    const player = byTestId<HTMLAudioElement>(renderer, tid.mediaPlayer("voice.ogg"))
    expect(player.tagName).toBe("AUDIO")
    expect(player).not.toHaveAttribute("controls")
    expect(player).toHaveAttribute("preload", "metadata")
    expect(player).not.toHaveAttribute("autoplay")
    expect(player).not.toHaveAttribute("playsinline")
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg")))
      .toHaveAttribute("aria-label", "Stop playback voice.ogg")
  })

  it("announces pending audio and leaves Stop available while Play is disabled", () => {
    const pendingPlay = new Promise<void>(() => {})
    const audio = attachment({ name: "voice.ogg", contentType: "audio/ogg" })
    const { renderer } = renderMedia({ item: audio, mediaKind: "audio", play: vi.fn(() => pendingPlay) })

    const stop = byTestId(renderer, tid.mediaCollapse("voice.ogg"))
    expect(stop).toBeDisabled()
    fireEvent.click(byTestId(renderer, tid.mediaPlay("voice.ogg")))
    const loadingButton = byTestId<HTMLButtonElement>(renderer, tid.mediaPlay("voice.ogg"))
    expect(loadingButton).toHaveAttribute("aria-label", "Loading voice.ogg")
    expect(loadingButton).toHaveAttribute("aria-busy", "true")
    expect(loadingButton).toBeDisabled()
    expect(byTestId(renderer, tid.mediaStatus("voice.ogg"))).toHaveTextContent("Loading media…")
    expect(byTestId(renderer, tid.mediaCollapse("voice.ogg"))).toBe(stop)
    expect(stop).toBeEnabled()
  })

  it.each(["audio"] as const)("stops %s at the beginning and retains its media and disabled Stop", async (mediaKind) => {
    const item = attachmentFor(mediaKind)
    const { renderer, mediaNode, seek } = renderMedia({ item, mediaKind })
    const stop = byTestId(renderer, tid.mediaCollapse(item.name))
    await clickAndFlush(byTestId(renderer, tid.mediaPlay(item.name)))

    const retainedPlayer = renderer.container.querySelector(mediaKind)
    expect(byTestId(renderer, tid.mediaCollapse(item.name))).toBe(stop)
    expect(stop).toHaveAttribute("aria-label", `Stop playback ${item.name}`)
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
    ["audio", "resolve"], ["audio", "reject"],
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

  it.each(["audio"] as const)("keeps %s blocked-play retry and Stop reachable", async (mediaKind) => {
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
    const NativeURL = URL
    const stopPropagation = vi.fn()
    const downloadClick = vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("media bytes")))
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:media")
      static revokeObjectURL = vi.fn()
    })
    const { renderer, mediaNode } = renderMedia()

    const click = new MouseEvent("click", { bubbles: true })
    Object.defineProperty(click, "stopPropagation", { value: stopPropagation })
    act(() => byTestId(renderer, tid.mediaDownload("voice.ogg")).dispatchEvent(click))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    const [input, init] = vi.mocked(fetch).mock.calls[0]!
    const effectiveRequest = new Request(
      input instanceof Request ? input : new NativeURL(String(input), window.location.href),
      init,
    )
    expect(effectiveRequest.url).toBe(new NativeURL("/attachments/video-1", window.location.href).href)
    expect(effectiveRequest.credentials).toBe("same-origin")
    expect(init?.signal ?? (input instanceof Request ? input.signal : undefined)).toBeInstanceOf(AbortSignal)
    expect(downloadClick.mock.contexts[0]).toEqual(expect.objectContaining({ href: "blob:media", download: "voice.ogg" }))
    expect(downloadClick).toHaveBeenCalledOnce()
    expect(renderer.getByRole("status")).toHaveTextContent("Download started")
    expect(mediaNode.play).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll("video")).toHaveLength(0)
  })
})
