import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { RemoteContentImage, RemoteIdentityImage } from "./remote-image"
import { RemoteMarkdownImage } from "./remote-markdown-image"

function setImageMetrics(
  image: HTMLImageElement,
  decode: () => Promise<void> = () => Promise.resolve(),
  naturalWidth = 320,
  naturalHeight = 200,
) {
  Object.defineProperties(image, {
    decode: { configurable: true, value: decode },
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  })
}

function contentImage(container: HTMLElement) {
  return container.querySelector<HTMLImageElement>('[data-remote-image-kind="content"]')!
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("remote image state adapters", () => {
  it("keeps an identity failure neutral and static", () => {
    const rendered = render(React.createElement(
      "span",
      { className: "relative block size-10" },
      React.createElement(RemoteIdentityImage, {
        src: "/avatar.png",
        alt: "Ada",
        placeholderClassName: "rounded-full",
      }),
    ))
    fireEvent.error(rendered.container.querySelector('[data-remote-image-kind="identity"]')!)

    const image = rendered.container.querySelector('[data-remote-image-kind="identity"]')!
    expect(image).toHaveAttribute("src", "/avatar.png")
    expect(image).toHaveAttribute("data-remote-image-state", "error")
    const placeholder = rendered.container.querySelector('[data-remote-image-placeholder="identity"]')!
    expect(placeholder).toHaveAttribute("data-remote-image-state", "error")
    expect(placeholder).not.toHaveAttribute("data-avatar-photo-placeholder")
    expect(placeholder).not.toHaveAttribute("data-slot")
    expect(placeholder).not.toHaveClass("animate-pulse")
    expect(rendered.container.querySelectorAll("svg")).toHaveLength(0)
  })

  it("retries content with the exact URL and fences callbacks from the old attempt", async () => {
    let resolveOldDecode!: () => void
    const oldDecode = new Promise<void>((resolve) => { resolveOldDecode = resolve })
    const rendered = render(React.createElement(RemoteContentImage, {
      src: "https://cdn.example.com/photo.png?size=2",
      alt: "Photo",
      loading: "eager",
      frameStyle: { width: 320, aspectRatio: "8/5" },
    }))
    const oldImage = contentImage(rendered.container)
    setImageMetrics(oldImage, () => oldDecode)
    fireEvent.load(oldImage)
    fireEvent.error(oldImage)
    const retry = screen.getByRole("button", { name: "Retry" })
    expect(retry).toHaveClass("min-h-11", "min-w-11")

    fireEvent.click(retry)
    const retried = contentImage(rendered.container)
    expect(retried).toHaveAttribute("src", "https://cdn.example.com/photo.png?size=2")
    expect(retried).toHaveAttribute("data-remote-image-state", "pending")

    await act(async () => {
      resolveOldDecode()
      await oldDecode
    })
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "pending")

    setImageMetrics(retried)
    fireEvent.load(retried)
    await act(async () => { await Promise.resolve() })
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "ready")
  })

  it("does not start a lazy timeout until the frame becomes viewport-eligible", async () => {
    vi.useFakeTimers()
    let observe!: IntersectionObserverCallback
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        observe = callback
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      readonly root = null
      readonly rootMargin = "300px"
      readonly thresholds = [0]
    })

    const rendered = render(React.createElement(RemoteContentImage, {
      src: "/below-the-fold.png",
      alt: "Below the fold",
      loading: "lazy",
      timeoutMs: 100,
      frameStyle: { width: 300, aspectRatio: "4/3" },
    }))
    await act(async () => vi.advanceTimersByTime(500))
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "pending")

    act(() => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    await act(async () => vi.advanceTimersByTime(100))
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "error")
  })

  it("rejects a decoded image without natural pixels", async () => {
    const rendered = render(React.createElement(RemoteContentImage, {
      src: "/empty.png",
      alt: "Empty image",
      loading: "eager",
      frameStyle: { width: 300, aspectRatio: "4/3" },
    }))

    const image = contentImage(rendered.container)
    setImageMetrics(image, () => Promise.resolve(), 0, 0)
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })

    expect(contentImage(rendered.container)).toHaveAttribute("src", "/empty.png")
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "error")
  })

  it("resets to pending when the source changes", () => {
    const image = (src: string) => React.createElement(RemoteContentImage, {
      src,
      alt: "Photo",
      loading: "eager",
      frameStyle: { width: 300, aspectRatio: "4/3" },
    })
    const rendered = render(image("/first.png"))
    fireEvent.error(contentImage(rendered.container))
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "error")

    rendered.rerender(image("/second.png"))
    expect(contentImage(rendered.container)).toHaveAttribute("src", "/second.png")
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "pending")
  })

  it("keeps Markdown image geometry and retries the exact source", () => {
    const rendered = render(React.createElement(RemoteMarkdownImage, {
      src: "https://cdn.example.com/diagram.png?version=2",
      alt: "Architecture diagram",
      width: "800",
      height: "400",
    }))

    const wrapper = rendered.container.querySelector<HTMLElement>('[data-streamdown="image-wrapper"]')!
    expect(wrapper.style.aspectRatio).toBe("800/400")
    const image = rendered.container.querySelector<HTMLImageElement>('[data-streamdown="image"]')!
    expect(image).toHaveAttribute("src", "https://cdn.example.com/diagram.png?version=2")
    expect(image).toHaveAttribute("alt", "Architecture diagram")
    expect(image).toHaveAttribute("loading", "lazy")
    expect(image).toHaveAttribute("width", "800")
    expect(image).toHaveAttribute("height", "400")
    expect(image).toHaveAttribute("data-remote-image-state", "pending")

    fireEvent.error(image)
    const retry = screen.getByRole("button", { name: "Retry" })
    expect(retry).toHaveClass("min-h-11")
    fireEvent.click(retry)

    expect(rendered.container.querySelector('[data-streamdown="image"]'))
      .toHaveAttribute("src", "https://cdn.example.com/diagram.png?version=2")
    expect(rendered.container.querySelector('[data-streamdown="image"]'))
      .toHaveAttribute("data-remote-image-state", "pending")
    expect(wrapper.style.aspectRatio).toBe("800/400")
  })

  it("reserves a safe frame for Markdown images without dimensions", () => {
    const rendered = render(React.createElement(RemoteMarkdownImage, {
      src: "/legacy.png",
      alt: "Legacy image",
    }))

    const wrapper = rendered.container.querySelector<HTMLElement>('[data-streamdown="image-wrapper"]')!
    expect(wrapper.style.aspectRatio).toBe("4/3")
    expect(rendered.container.querySelector('[data-streamdown="image"]')).not.toHaveAttribute("width")
  })
})
