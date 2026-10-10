import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"

const useMessageMock = vi.fn()
vi.mock("@/hooks/community/use-message", () => ({
  useMessage: (...args: unknown[]) => useMessageMock(...args),
}))
vi.mock("@/lib/community-db/projections", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/community-db/projections")>(),
  useCanonicalCommunityProfile: (userId?: string) => userId
    ? { id: userId, name: "Alice", avatar: "A" }
    : undefined,
}))
vi.mock("@/hooks/use-hover-capable", () => ({ useHoverCapable: () => true }))
vi.mock("./message-reactions", () => ({
  MessageReactions: ({ onToggleReaction }: { onToggleReaction?: (emoji: string) => void }) =>
    React.createElement("button", {
      "data-testid": "mock-opener-reaction",
      onClick: () => onToggleReaction?.("🔥"),
    }, "🔥"),
}))

import { ThreadOpener } from "./thread-opener"
import { attachmentImageFrameStyle } from "./attachment-layout"

describe("ThreadOpener image attachment layout", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(["attachment", "Markdown"])("retires a previous opener's $name attempt even when its source is reused", async (kind) => {
    const select = (id: string) => useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id, type: "chat", authorId: "user_1", authorName: "Alice", createdAt: "2026-08-08T00:00:00.000Z",
        content: kind === "Markdown" ? "![Image](/same.png)" : "Image",
        attachments: kind === "attachment" ? [{ kind: "image", name: "same.png", url: "/same.png" }] : undefined,
      },
    })
    const tree = (id: string) => React.createElement(ThreadOpener, {
      parentMessageId: id, parentChannelId: "parent_1", serverId: "server_1", viewerUserId: "viewer_1",
    })
    select("one")
    const renderer = render(tree("one"))
    const current = () => renderer.container.querySelector<HTMLImageElement>('[data-remote-image-kind="content"]')!
    const first = current()
    let finish!: () => void
    const obsolete = new Promise<void>((resolve) => { finish = resolve })
    Object.defineProperties(first, {
      decode: { configurable: true, value: () => obsolete },
      naturalWidth: { configurable: true, value: 320 },
      naturalHeight: { configurable: true, value: 200 },
    })
    fireEvent.load(first)
    renderer.rerender(tree("one"))
    expect(current()).toBe(first)
    select("two")
    renderer.rerender(tree("two"))
    const next = current()
    expect(next).not.toBe(first)
    expect(first.isConnected).toBe(false)
    await act(async () => { finish(); await obsolete })
    expect(next).toHaveAttribute("src", "/same.png")
    expect(next).toHaveAttribute("data-remote-image-state", "pending")
    expect(next).toHaveClass("opacity-0")
  })

  it("renders projected reply content in the opener", () => {
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1",
        type: "chat",
        authorId: "user_1",
        authorName: "Stale Alice",
        content: "@Bob Smith\n**visible** body",
        replyTo: { id: "prior", authorName: "Bob Smith", text: "original" },
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    })

    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          parentChannelId: "parent_1",
          serverId: "server_1",
          viewerUserId: "viewer_1",
        })
      )
    })

    const body = renderer!.container.querySelector('[data-community-message-body="true"]')!
    expect(body.textContent).not.toContain("@Bob Smith")
    expect(body).toHaveTextContent("visible")
  })

  it("threads reaction toggles through the live opener surface", () => {
    const onToggleReaction = vi.fn()
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1",
        type: "chat",
        authorId: "user_1",
        authorName: "Alice",
        content: "React here",
        createdAt: "2026-08-08T00:00:00.000Z",
        reactions: [{ emoji: "🔥", count: 1, me: false, userIds: ["user_1"] }],
      },
    })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          parentChannelId: "parent_1",
          serverId: "server_1",
          viewerUserId: "viewer_1",
          onToggleReaction,
        })
      )
    })
    fireEvent.click(renderer!.getByTestId("mock-opener-reaction"))
    expect(onToggleReaction).toHaveBeenCalledWith("🔥")
  })

  it("keeps a known portrait image intrinsic and constrains it by message width + max height", () => {
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1",
        type: "chat",
        authorId: "user_1",
        authorName: "Alice",
        content: "Portrait",
        createdAt: "2026-08-08T00:00:00.000Z",
        attachments: [{
          kind: "image",
          name: "portrait.png",
          url: "/portrait.png",
          width: 396,
          height: 702,
        }],
      },
    })

    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          parentChannelId: "parent_1",
          serverId: "server_1",
          viewerUserId: "viewer_1",
        })
      )
    })

    const image = renderer!.container.querySelector("img")!
    expect(image).toHaveAttribute("src", "/portrait.png")
    expect(image).toHaveAttribute("width", "396")
    expect(image).toHaveAttribute("height", "702")
    expect(image.className).toContain("size-full")
    expect(image.className).toContain("absolute")
    const frame = renderer!.container.querySelector<HTMLElement>('[data-remote-image-frame="true"]')!
    expect(frame.className).toContain("relative")
    expect(frame.className).toContain("max-w-full")
    expect(frame.className).toContain("sm:[--attachment-image-max-height:240px]")
    expect(attachmentImageFrameStyle(396, 702)).toEqual({
      width: "min(100%, 396px, calc(var(--attachment-image-max-height, 200px) * 396 / 702))",
      aspectRatio: "396/702",
    })
    expect(frame.style.aspectRatio).toBe("396/702")
  })

  it("uses thumbnailUrl for the list image and passes the original on click", () => {
    const onPreviewImage = vi.fn()
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1", type: "chat", authorId: "u1", authorName: "Alice",
        content: "Photo", createdAt: "2026-08-08T00:00:00.000Z",
        attachments: [{
          kind: "image", name: "photo.png", url: "/original", thumbnailUrl: "/thumbnail",
          width: 640, height: 480,
        }],
      },
    })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          parentChannelId: "parent_1",
          serverId: "server_1",
          onPreviewImage,
        })
      )
    })
    const image = renderer!.container.querySelector("img")!
    expect(image).toHaveAttribute("src", "/thumbnail")
    expect(image).toHaveAttribute("loading", "lazy")
    fireEvent.click(image.parentElement!)
    expect(onPreviewImage).toHaveBeenCalledWith({
      originalUrl: "/original", thumbnailUrl: "/thumbnail", name: "photo.png",
      width: 640, height: 480,
    })
  })

  it("uses the same previewable file card as regular messages", () => {
    const onPreviewAttachment = vi.fn()
    const file = {
      kind: "file" as const,
      name: "notes.md",
      url: "/notes",
      contentType: "text/markdown",
      sizeBytes: 128,
      size: "128 B",
    }
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1", type: "chat", authorId: "u1", authorName: "Alice",
        content: "Notes", createdAt: "2026-08-08T00:00:00.000Z",
        attachments: [file],
      },
    })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          parentChannelId: "parent_1",
          serverId: "server_1",
          onPreviewAttachment,
        })
      )
    })
    const card = renderer!.getByTestId("community-attachment-card-notes.md")
    fireEvent.click(card)
    expect(onPreviewAttachment).toHaveBeenCalledWith(file)
  })

  it("renders opener media through the shared progressive-disclosure block", () => {
    const media = {
      kind: "file" as const,
      name: "clip.webm",
      url: "/clip",
      contentType: "video/webm",
      sizeBytes: 512,
      size: "512 B",
    }
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1", type: "chat", authorId: "u1", authorName: "Alice",
        content: "Clip", createdAt: "2026-08-08T00:00:00.000Z",
        attachments: [media],
      },
    })
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          parentChannelId: "parent_1",
          serverId: "server_1",
        })
      )
    })

    expect(renderer!.getByTestId("community-media-block-clip.webm"))
      .toHaveAttribute("data-media-kind", "video")
    expect(renderer!.container.querySelectorAll("video")).toHaveLength(0)
  })

  it("uses the shared mobile avatar long press without leaking cancelled clicks to profile", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("navigator", { vibrate: vi.fn() })
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1",
        type: "chat",
        authorId: "user_1",
        authorName: "Alice",
        content: "Thread opener",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    })
    const onInsertMentionText = vi.fn()
    const onOpenProfile = vi.fn()
    let renderer: ReturnType<typeof render>
    act(() => {
      renderer = render(React.createElement(ThreadOpener, {
        parentMessageId: "opener_1",
        parentChannelId: "parent_1",
        serverId: "server_1",
        viewerUserId: "viewer_1",
        onOpenProfile,
        resolveAuthorMentionText: () => "@Alice#0042",
        onInsertMentionText,
      }))
    })
    const avatar = renderer!.getByLabelText("Open Alice profile; long press to mention")

    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 20, clientY: 20 })
    act(() => vi.advanceTimersByTime(500))
    expect(onInsertMentionText).toHaveBeenCalledOnce()
    expect(onInsertMentionText).toHaveBeenCalledWith("@Alice#0042")
    fireEvent.click(avatar)
    expect(onOpenProfile).not.toHaveBeenCalled()

    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 20, clientY: 20 })
    fireEvent.pointerCancel(avatar, { pointerType: "touch" })
    fireEvent.click(avatar)
    expect(onOpenProfile).not.toHaveBeenCalled()

    fireEvent.pointerDown(avatar, { pointerType: "touch", clientX: 20, clientY: 20 })
    fireEvent.pointerUp(avatar, { pointerType: "touch" })
    fireEvent.click(avatar)
    expect(onOpenProfile).toHaveBeenCalledOnce()
    act(() => renderer!.unmount())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(vi.getTimerCount()).toBe(0)
  })
})
