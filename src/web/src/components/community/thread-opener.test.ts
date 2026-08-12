import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

const useMessageMock = vi.fn()
vi.mock("@/hooks/community/use-message", () => ({
  useMessage: (...args: unknown[]) => useMessageMock(...args),
}))

import { ThreadOpener } from "./thread-opener"

const genericMock = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
}

describe("ThreadOpener image attachment layout", () => {
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
        React.createElement(ThreadOpener, { parentMessageId: "opener_1" }),
        { createNodeMock: () => genericMock },
      )
    })

    const image = renderer!.root.findByType("img")
    expect(image.props.src).toBe("/portrait.png")
    expect(image.props).toMatchObject({ width: 396, height: 702 })
    expect(image.props.className).toContain("h-auto")
    expect(image.props.className).toContain("w-auto")
    expect(image.props.className).toContain("max-h-75")
    expect(image.props.className).toContain("max-w-full")
    expect(image.parent?.props.className).toContain("w-fit")
    expect(image.parent?.props.className).toContain("max-w-full")
  })

  it("uses thumbnailUrl for the list image and passes the original on click", () => {
    const onPreviewImage = vi.fn()
    useMessageMock.mockReturnValue({
      isLoading: false,
      isError: false,
      message: {
        id: "opener_1", type: "chat", authorId: "u1", authorName: "Alice",
        content: "Photo", createdAt: "2026-08-08T00:00:00.000Z",
        attachments: [{ kind: "image", name: "photo.png", url: "/original", thumbnailUrl: "/thumbnail" }],
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
    })
  })
})
