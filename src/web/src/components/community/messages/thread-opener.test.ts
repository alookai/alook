import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

const useMessageMock = vi.fn()
vi.mock("@/hooks/community/use-message", () => ({
  useMessage: (...args: unknown[]) => useMessageMock(...args),
}))
vi.mock("@/stores/community/ws", () => ({
  useCommunityProfile: (userId?: string) => userId
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

const genericMock = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => (
    typeof child === "string" ? child : textContent(child)
  )).join("")
}

describe("ThreadOpener image attachment layout", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          viewerUserId: "viewer_1",
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const body = renderer!.root.findByProps({ "data-community-message-body": true })
    expect(textContent(body)).not.toContain("@Bob Smith")
    expect(textContent(body)).toContain("visible")
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          viewerUserId: "viewer_1",
          onToggleReaction,
        }),
        { createNodeMock: () => genericMock },
      )
    })
    act(() => renderer!.root.findByProps({ "data-testid": "mock-opener-reaction" }).props.onClick())
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

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThreadOpener, {
          parentMessageId: "opener_1",
          viewerUserId: "viewer_1",
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const image = renderer!.root.findByType("img")
    expect(image.props.src).toBe("/portrait.png")
    expect(image.props).toMatchObject({ width: 396, height: 702 })
    expect(image.props.className).toContain("size-full")
    expect(image.props.className).toContain("absolute")
    expect(image.parent?.props.className).toContain("relative")
    expect(image.parent?.props.className).toContain("max-w-full")
    expect(image.parent?.props.style).toEqual({
      width: "min(100%, 169.231px)",
      aspectRatio: "396/702",
    })
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThreadOpener, { parentMessageId: "opener_1", onPreviewImage }),
        { createNodeMock: () => genericMock },
      )
    })
    const image = renderer!.root.findByType("img")
    expect(image.props).toMatchObject({ src: "/thumbnail", loading: "lazy" })
    act(() => image.parent!.props.onClick())
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThreadOpener, { parentMessageId: "opener_1", onPreviewAttachment }),
        { createNodeMock: () => genericMock },
      )
    })
    const card = renderer!.root.findByProps({ "data-testid": "community-attachment-card-notes.md" })
    act(() => card.props.onClick())
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(ThreadOpener, { parentMessageId: "opener_1" }),
        { createNodeMock: () => genericMock },
      )
    })

    expect(renderer!.root.findByProps({ "data-testid": "community-media-block-clip.webm" }).props["data-media-kind"])
      .toBe("video")
    expect(renderer!.root.findAllByType("video")).toHaveLength(0)
  })

  it("uses the shared mobile avatar long press without leaking cancelled clicks to profile", () => {
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ThreadOpener, {
        parentMessageId: "opener_1",
        viewerUserId: "viewer_1",
        onOpenProfile,
        resolveAuthorMentionText: () => "@Alice#0042",
        onInsertMentionText,
      }), { createNodeMock: () => genericMock })
    })
    const avatar = renderer!.root.findByProps({
      "aria-label": "Open Alice profile; long press to mention",
    })
    const clickEvent = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })

    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 20, clientY: 20 }))
    act(() => vi.advanceTimersByTime(500))
    expect(onInsertMentionText).toHaveBeenCalledOnce()
    expect(onInsertMentionText).toHaveBeenCalledWith("@Alice#0042")
    act(() => avatar.props.onClick(clickEvent()))
    expect(onOpenProfile).not.toHaveBeenCalled()

    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 20, clientY: 20 }))
    act(() => avatar.props.onPointerCancel({ pointerType: "touch" }))
    act(() => avatar.props.onClick(clickEvent()))
    expect(onOpenProfile).not.toHaveBeenCalled()

    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 20, clientY: 20 }))
    act(() => avatar.props.onPointerUp({ pointerType: "touch" }))
    act(() => avatar.props.onClick(clickEvent()))
    expect(onOpenProfile).toHaveBeenCalledOnce()
    act(() => renderer!.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })
})
