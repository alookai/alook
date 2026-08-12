import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("section", null, children),
}))

import { ImageLightbox } from "./image-lightbox"

describe("ImageLightbox", () => {
  it("keeps the thumbnail painted until the clicked original loads", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ImageLightbox, {
        image: { originalUrl: "/original", thumbnailUrl: "/thumbnail", name: "photo" },
        onClose: vi.fn(),
      }))
    })
    const images = renderer!.root.findAllByType("img")
    expect(images.map((image) => image.props.src)).toEqual(["/thumbnail", "/original"])
    expect(images[1].props.className).toContain("invisible")
    act(() => images[1].props.onLoad())
    expect(renderer!.root.findAllByType("img")[1].props.className).not.toContain("invisible")
  })

  it("retains the thumbnail when the original fails", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ImageLightbox, {
        image: { originalUrl: "/original", thumbnailUrl: "/thumbnail", name: "photo" },
        onClose: vi.fn(),
      }))
    })
    act(() => renderer!.root.findAllByType("img")[1].props.onError())
    const images = renderer!.root.findAllByType("img")
    expect(images).toHaveLength(1)
    expect(images[0].props.src).toBe("/thumbnail")
  })
})
