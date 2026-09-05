import React from "react"

import TestRenderer, { act } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RemoteContentImage, RemoteIdentityImage } from "./remote-image"
import { RemoteMarkdownImage } from "./remote-markdown-image"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function imageEvent(
  decode: () => Promise<void> = () => Promise.resolve(),
  naturalWidth = 320,
  naturalHeight = 200,
) {
  return { currentTarget: { decode, naturalWidth, naturalHeight } }
}

function createNodeMock(element: React.ReactElement) {
  if (element.type === "img") {
    return { complete: false, naturalWidth: 0, naturalHeight: 0 }
  }
  if (element.props["data-remote-image-frame"] !== undefined) return {}
  return null
}

describe("remote image state adapters", () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount())
    renderer = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("keeps an identity failure neutral and static", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          "span",
          { className: "relative block size-10" },
          React.createElement(RemoteIdentityImage, {
            src: "/avatar.png",
            alt: "Ada",
            placeholderClassName: "rounded-full",
          }),
        ),
      )
    })
    const image = renderer!.root.findByProps({ "data-remote-image-kind": "identity" })
    await act(async () => image.props.onError())

    expect(renderer!.root.findByProps({ "data-remote-image-kind": "identity" }).props)
      .toMatchObject({ src: "/avatar.png", "data-remote-image-state": "error" })
    const placeholder = renderer!.root.findByProps({ "data-remote-image-placeholder": "identity" })
    expect(placeholder.props["data-remote-image-state"]).toBe("error")
    expect(placeholder.props["data-avatar-photo-placeholder"]).toBeUndefined()
    expect(placeholder.props["data-slot"]).toBeUndefined()
    expect(placeholder.props.className).not.toContain("animate-pulse")
    expect(renderer!.root.findAll((node) => node.type === "svg")).toHaveLength(0)
  })

  it("retries content with the exact URL and fences callbacks from the old attempt", async () => {
    let resolveOldDecode!: () => void
    const oldDecode = new Promise<void>((resolve) => { resolveOldDecode = resolve })
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(RemoteContentImage, {
          src: "https://cdn.example.com/photo.png?size=2",
          alt: "Photo",
          loading: "eager",
          frameStyle: { width: 320, aspectRatio: "8/5" },
        }),
        { createNodeMock },
      )
    })
    const oldImage = renderer!.root.findByProps({ "data-remote-image-kind": "content" })
    const oldOnLoad = oldImage.props.onLoad
    const oldOnError = oldImage.props.onError

    act(() => oldOnLoad(imageEvent(() => oldDecode)))
    await act(async () => oldOnError())
    const retry = renderer!.root.findByType("button")
    expect(retry.props.className).toContain("min-h-11")
    expect(retry.props.className).toContain("min-w-11")

    await act(async () => retry.props.onClick())
    const retried = renderer!.root.findByProps({ "data-remote-image-kind": "content" })
    expect(retried.props.src).toBe("https://cdn.example.com/photo.png?size=2")
    expect(retried.props["data-remote-image-state"]).toBe("pending")

    await act(async () => {
      oldOnError()
      resolveOldDecode()
      await oldDecode
    })
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props["data-remote-image-state"])
      .toBe("pending")

    await act(async () => {
      retried.props.onLoad(imageEvent())
      await Promise.resolve()
    })
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props["data-remote-image-state"])
      .toBe("ready")
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

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(RemoteContentImage, {
          src: "/below-the-fold.png",
          alt: "Below the fold",
          loading: "lazy",
          timeoutMs: 100,
          frameStyle: { width: 300, aspectRatio: "4/3" },
        }),
        { createNodeMock },
      )
    })
    await act(async () => vi.advanceTimersByTime(500))
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props["data-remote-image-state"])
      .toBe("pending")

    await act(async () => observe([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    await act(async () => vi.advanceTimersByTime(100))
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props["data-remote-image-state"])
      .toBe("error")
  })

  it("rejects a decoded image without natural pixels", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(RemoteContentImage, {
          src: "/empty.png",
          alt: "Empty image",
          loading: "eager",
          frameStyle: { width: 300, aspectRatio: "4/3" },
        }),
        { createNodeMock },
      )
    })

    const image = renderer!.root.findByProps({ "data-remote-image-kind": "content" })
    await act(async () => {
      image.props.onLoad(imageEvent(() => Promise.resolve(), 0, 0))
      await Promise.resolve()
    })

    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props)
      .toMatchObject({ src: "/empty.png", "data-remote-image-state": "error" })
  })

  it("resets to pending when the source changes", async () => {
    const render = (src: string) => React.createElement(RemoteContentImage, {
      src,
      alt: "Photo",
      loading: "eager",
      frameStyle: { width: 300, aspectRatio: "4/3" },
    })
    await act(async () => {
      renderer = TestRenderer.create(render("/first.png"), { createNodeMock })
    })
    await act(async () => renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props.onError())
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props["data-remote-image-state"])
      .toBe("error")

    await act(async () => renderer!.update(render("/second.png")))
    expect(renderer!.root.findByProps({ "data-remote-image-kind": "content" }).props)
      .toMatchObject({ src: "/second.png", "data-remote-image-state": "pending" })
  })

  it("keeps Markdown image geometry and retries the exact source", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(RemoteMarkdownImage, {
          src: "https://cdn.example.com/diagram.png?version=2",
          alt: "Architecture diagram",
          width: "800",
          height: "400",
        }),
        { createNodeMock },
      )
    })

    const wrapper = renderer!.root.findByProps({ "data-streamdown": "image-wrapper" })
    expect(wrapper.props.style).toEqual({ width: "min(100%, 600px)", aspectRatio: "800/400" })
    const image = renderer!.root.findByProps({ "data-streamdown": "image" })
    expect(image.props).toMatchObject({
      src: "https://cdn.example.com/diagram.png?version=2",
      alt: "Architecture diagram",
      loading: "lazy",
      "data-remote-image-state": "pending",
    })

    await act(async () => image.props.onError())
    const retry = renderer!.root.findByType("button")
    expect(retry.children).toEqual(["Retry"])
    expect(retry.props.className).toContain("min-h-11")
    await act(async () => retry.props.onClick())

    expect(renderer!.root.findByProps({ "data-streamdown": "image" }).props).toMatchObject({
      src: "https://cdn.example.com/diagram.png?version=2",
      "data-remote-image-state": "pending",
    })
    expect(renderer!.root.findByProps({ "data-streamdown": "image-wrapper" }).props.style)
      .toEqual({ width: "min(100%, 600px)", aspectRatio: "800/400" })
  })

  it("reserves a safe frame for Markdown images without dimensions", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(RemoteMarkdownImage, {
          src: "/legacy.png",
          alt: "Legacy image",
        }),
        { createNodeMock },
      )
    })

    expect(renderer!.root.findByProps({ "data-streamdown": "image-wrapper" }).props.style)
      .toEqual({ width: "min(100%, 300px)", aspectRatio: "4/3" })
  })
})
