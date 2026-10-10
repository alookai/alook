import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { renderCommunity } from "@/test/community-owner-harness"
import { RemoteContentImage, RemoteIdentityImage } from "./remote-image"
import { RemoteMarkdownImage } from "./remote-markdown-image"
import { ShareImagePreparationContext } from "./share-image-context"
import { ApplicationOwnerProvider, createApplicationOwner } from "@/lib/application-owner"
import { AgentAvatar } from "@/components/avatar/agent-avatar"
import { AnimatedAvatar } from "@/components/avatar/animated-avatar"
import { ServerIcon } from "@/components/community/server-icon"

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("remote image state adapters", () => {
  const identityElement = (src: string, identityKey = "peer") => React.createElement(RemoteIdentityImage, {
    src, identityKey, alt: "Peer", profilePhoto: true, "data-testid": "identity-photo",
  })
  const sourceImage = (container: HTMLElement, src: string) => [...container.querySelectorAll<HTMLImageElement>("img")]
    .find((image) => image.getAttribute("src") === src)!
  const makeReady = async (image: HTMLImageElement) => {
    setImageMetrics(image)
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
  }

  it("shows a complete identity image with natural pixels synchronously without another decode", () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode")
    const decode = vi.fn(() => new Promise<void>(() => {}))
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode })
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(40)
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(40)
    try {
      for (let mount = 0; mount < 2; mount++) {
        const rendered = render(identityElement("/cached.png"))
        expect(sourceImage(rendered.container, "/cached.png")).toHaveAttribute("data-remote-image-state", "ready")
        expect(sourceImage(rendered.container, "/cached.png")).toHaveClass("opacity-100")
        expect(rendered.container.querySelector(".animate-pulse")).toBeNull()
        rendered.unmount()
      }
      expect(decode).not.toHaveBeenCalled()
    } finally {
      if (descriptor) Object.defineProperty(HTMLImageElement.prototype, "decode", descriptor)
      else delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode
    }
  })

  it.each([false, true])("shows content and Markdown cached pixels synchronously (StrictMode: %s)", (strict) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode")
    const decode = vi.fn(() => new Promise<void>(() => {}))
    Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode })
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true)
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(40)
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(40)
    const owner = createApplicationOwner("cached-content-viewer")
    try {
      const tree = React.createElement(ApplicationOwnerProvider, { owner },
        React.createElement(RemoteContentImage, { src: "/cached-content.png", alt: "Content" }),
        React.createElement(RemoteMarkdownImage, { src: "/cached-markdown.png", alt: "Markdown" }),
      )
      for (let mount = 0; mount < 2; mount++) {
        const rendered = render(strict ? React.createElement(React.StrictMode, null, tree) : tree)
        const images = [...rendered.container.querySelectorAll("img")]
        expect(images.every((image) => image.dataset.remoteImageState === "ready")).toBe(true)
        expect(images.every((image) => image.classList.contains("opacity-100"))).toBe(true)
        expect(images.every((image) => !image.classList.contains("transition-opacity"))).toBe(true)
        expect(rendered.container.querySelector("[data-remote-image-placeholder]")).toBeNull()
        rendered.unmount()
      }
      expect(decode).not.toHaveBeenCalled()
    } finally {
      owner.queryClient.clear()
      if (descriptor) Object.defineProperty(HTMLImageElement.prototype, "decode", descriptor)
      else delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode
    }
  })

  it.each([
    { name: "content", element: (src: string, alt: string) => React.createElement(RemoteContentImage, { src, alt }) },
    { name: "Markdown", element: (src: string, alt: string) => React.createElement(RemoteMarkdownImage, { src, alt }) },
  ])("keeps the same ready $name node on a same-source update and recovers the exact URL on online", async ({ element }) => {
    const source = "/same.png?v=2&size=40"
    const rendered = renderCommunity(element(source, "Before"))
    const original = contentImage(rendered.container)
    await makeReady(original)
    rendered.rerender(element(source, "After"))
    expect(contentImage(rendered.container)).toBe(original)
    fireEvent(window, new Event("online"))
    expect(contentImage(rendered.container)).toBe(original)
    expect(original).toHaveAttribute("data-remote-image-state", "ready")

    rendered.rerender(element("/failed.png?v=3&size=40", "Failed"))
    const failed = contentImage(rendered.container)
    fireEvent.error(failed)
    fireEvent(window, new Event("online"))
    const retried = contentImage(rendered.container)
    expect(retried).not.toBe(failed)
    expect(retried).toHaveAttribute("src", "/failed.png?v=3&size=40")
    expect(retried).toHaveAttribute("data-remote-image-state", "pending")
    await makeReady(retried)
    expect(retried).toHaveAttribute("data-remote-image-state", "ready")
  })

  it.each([
    { name: "identity", element: () => identityElement("/share.png") },
    { name: "content", element: () => React.createElement(RemoteContentImage, { src: "/share.png", alt: "Content" }) },
    { name: "Markdown", element: () => React.createElement(RemoteMarkdownImage, { src: "/share.png", alt: "Markdown" }) },
  ])("retires $name readiness and keeps its URL inert throughout share preparation and online", async ({ element }) => {
    const tree = (preparing: boolean) => React.createElement(ShareImagePreparationContext, { value: preparing }, element())
    const rendered = renderCommunity(tree(false))
    const live = rendered.container.querySelector<HTMLImageElement>("img")!
    await makeReady(live)
    rendered.rerender(tree(true))
    const inert = rendered.container.querySelector<HTMLImageElement>("img")!
    expect(inert).not.toBe(live)
    expect(live.isConnected).toBe(false)
    expect(inert).not.toHaveAttribute("src")
    expect(inert).toHaveAttribute("data-share-image-src", "/share.png")
    fireEvent(window, new Event("online"))
    fireEvent.load(inert)
    expect(rendered.container.querySelector("img")).toBe(inert)
    expect(inert).not.toHaveAttribute("src")
    expect(inert).toHaveAttribute("data-remote-image-state", "pending")
    rendered.rerender(tree(false))
    const resumed = rendered.container.querySelector<HTMLImageElement>("img")!
    expect(resumed).not.toBe(inert)
    expect(resumed).toHaveAttribute("src", "/share.png")
    expect(resumed).toHaveAttribute("data-remote-image-state", "pending")
  })

  it.each([
    { complete: true, width: 0, height: 0, currentSrc: "", status: "error" },
    { complete: false, width: 40, height: 40, currentSrc: "", status: "pending" },
    { complete: true, width: 40, height: 40, currentSrc: "https://wrong.example/old.png", status: "pending" },
  ])("checks complete, current source and natural pixels before cached readiness: %j", ({ complete, width, height, currentSrc, status }) => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(complete)
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(width)
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(height)
    vi.spyOn(HTMLImageElement.prototype, "currentSrc", "get").mockReturnValue(currentSrc)
    const rendered = render(React.createElement(RemoteContentImage, { src: "/current.png", alt: "Current" }))
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", status)
    expect(contentImage(rendered.container)).toHaveClass("opacity-0")
  })

  it("keeps the same ready identity node when only its props update", async () => {
    const rendered = render(identityElement("/peer?v=1"))
    const original = sourceImage(rendered.container, "/peer?v=1")
    await makeReady(original)
    rendered.rerender(identityElement("/peer?v=1"))
    expect(sourceImage(rendered.container, "/peer?v=1")).toBe(original)
    expect(original).toHaveClass("opacity-100")
    expect(rendered.container.querySelector(".animate-pulse")).toBeNull()
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
  })

  it("keeps one identity node visible during native source replacement without exposing a placeholder", async () => {
    const rendered = render(identityElement("/peer?v=1"))
    const original = sourceImage(rendered.container, "/peer?v=1")
    await makeReady(original)
    rendered.rerender(identityElement("/peer?v=2"))
    expect(original.isConnected).toBe(true)
    expect(sourceImage(rendered.container, "/peer?v=2")).toBe(original)
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
    expect(original).toHaveClass("opacity-100")
    expect(rendered.container.querySelector(".animate-pulse")).toBeNull()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    setImageMetrics(original, () => pending)
    fireEvent.load(original)
    expect(original.isConnected).toBe(true)
    await act(async () => { finish(); await pending })
    expect(sourceImage(rendered.container, "/peer?v=2")).toBe(original)
    expect(original).toHaveClass("opacity-100")
    expect(original).toHaveAttribute("data-remote-image-state", "ready")
    expect(original).toHaveAttribute("alt", "Peer")
    expect(rendered.getAllByRole("img", { name: "Peer" })).toHaveLength(1)
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
  })

  it("keeps one node for static failure and exact-source online retry while fencing the prior decode", async () => {
    const rendered = render(identityElement("/peer?v=1"))
    const original = sourceImage(rendered.container, "/peer?v=1")
    await makeReady(original)
    rendered.rerender(identityElement("/peer?v=2&size=40"))
    const current = sourceImage(rendered.container, "/peer?v=2&size=40")
    expect(current).toBe(original)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    setImageMetrics(current, () => pending)
    fireEvent.load(current)
    fireEvent.error(current)
    expect(original.isConnected).toBe(true)
    expect(original).toHaveClass("opacity-0")
    expect(original).toHaveAttribute("data-remote-image-state", "error")
    expect(rendered.container.querySelector(".animate-pulse")).toBeNull()
    fireEvent(window, new Event("online"))
    const retried = sourceImage(rendered.container, "/peer?v=2&size=40")
    expect(retried).toBe(original)
    expect(original.isConnected).toBe(true)
    await act(async () => { finish(); await pending })
    expect(retried).toHaveAttribute("data-remote-image-state", "pending")
    await makeReady(retried)
    expect(original.isConnected).toBe(true)
    expect(retried).toHaveClass("opacity-100")
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
  })

  it("keeps A's node when A is requested again and rejects B's late success", async () => {
    const rendered = render(identityElement("/a.png"))
    const original = sourceImage(rendered.container, "/a.png")
    await makeReady(original)
    rendered.rerender(identityElement("/b.png"))
    expect(sourceImage(rendered.container, "/b.png")).toBe(original)
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    setImageMetrics(original, () => pending)
    fireEvent.load(original)
    rendered.rerender(identityElement("/a.png"))
    expect(sourceImage(rendered.container, "/a.png")).toBe(original)
    await act(async () => { finish(); await pending })
    expect(sourceImage(rendered.container, "/a.png")).toBe(original)
    expect(original).toHaveAttribute("data-remote-image-state", "pending")
    expect(original).toHaveClass("opacity-100")
    await makeReady(original)
    expect(original).toHaveAttribute("data-remote-image-state", "ready")
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
  })

  it("fences B's obsolete decode on the same node until C succeeds", async () => {
    const rendered = render(identityElement("/a.png"))
    const original = sourceImage(rendered.container, "/a.png")
    await makeReady(original)
    rendered.rerender(identityElement("/b.png"))
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const obsolete = sourceImage(rendered.container, "/b.png")
    setImageMetrics(obsolete, () => pending)
    fireEvent.load(obsolete)
    rendered.rerender(identityElement("/c.png"))
    expect(original.isConnected).toBe(true)
    expect(obsolete).toBe(original)
    await act(async () => { finish(); await pending })
    expect(original).toHaveClass("opacity-100")
    expect(sourceImage(rendered.container, "/c.png")).toHaveAttribute("data-remote-image-state", "pending")
    await makeReady(sourceImage(rendered.container, "/c.png"))
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
    expect(original.isConnected).toBe(true)
  })

  it("does not publish the previous native currentSrc as readiness for the new source", async () => {
    const rendered = render(identityElement("/a.png"))
    const original = sourceImage(rendered.container, "/a.png")
    await makeReady(original)
    const decode = vi.fn(async () => {})
    setImageMetrics(original, decode)
    Object.defineProperties(original, {
      complete: { configurable: true, value: true },
      currentSrc: { configurable: true, value: new URL("/a.png", window.location.href).href },
    })
    rendered.rerender(identityElement("/b.png"))
    expect(sourceImage(rendered.container, "/b.png")).toBe(original)
    expect(original).toHaveAttribute("data-remote-image-state", "pending")
    fireEvent.load(original)
    await act(async () => { await Promise.resolve() })
    expect(decode).not.toHaveBeenCalled()
    expect(original).toHaveAttribute("data-remote-image-state", "pending")
    expect(original).toHaveClass("opacity-100")
    Object.defineProperty(original, "currentSrc", { configurable: true, value: original.src })
    fireEvent.load(original)
    await act(async () => { await Promise.resolve() })
    expect(original).toHaveAttribute("data-remote-image-state", "ready")
  })

  it("retires the host for a different identity even when the source is identical", async () => {
    const rendered = render(identityElement("/same.png", "person-a"))
    const original = sourceImage(rendered.container, "/same.png")
    await makeReady(original)
    rendered.rerender(identityElement("/same.png", "person-b"))
    const current = sourceImage(rendered.container, "/same.png")
    expect(current).not.toBe(original)
    expect(original.isConnected).toBe(false)
    expect(current).toHaveAttribute("data-remote-image-state", "pending")
  })

  it("keeps sources isolated when no stable identity is supplied", async () => {
    const element = (src: string) => React.createElement(RemoteIdentityImage, { src, alt: "Unknown" })
    const rendered = render(element("/one.png"))
    const original = sourceImage(rendered.container, "/one.png")
    await makeReady(original)
    rendered.rerender(element("/two.png"))
    expect(original.isConnected).toBe(false)
    expect(sourceImage(rendered.container, "/two.png")).toHaveAttribute("data-remote-image-state", "pending")
  })

  it("retires retained pixels when entering a share preparation tree", async () => {
    const element = (preparing: boolean, src: string) => React.createElement(ShareImagePreparationContext, { value: preparing }, identityElement(src))
    const rendered = render(element(false, "/a.png"))
    const original = sourceImage(rendered.container, "/a.png")
    await makeReady(original)
    rendered.rerender(element(false, "/b.png"))
    rendered.rerender(element(true, "/b.png"))
    expect(original.isConnected).toBe(false)
    const images = [...rendered.container.querySelectorAll("img")]
    expect(images).toHaveLength(1)
    expect(images[0]).toHaveAttribute("data-share-image-src", "/b.png")
    expect(images[0]).not.toHaveAttribute("src")
  })

  it.each([
    { name: "agent", element: (src: string, id: string) => React.createElement(AgentAvatar, { avatarUrl: src, seed: id, name: "Bot" }) },
    { name: "animated", element: (src: string, id: string) => React.createElement(AnimatedAvatar, { avatarUrl: src, seed: id, isHovered: false }) },
    { name: "server", element: (src: string, id: string) => React.createElement(ServerIcon, { icon: src, id, name: "Server", initial: "S" }) },
  ])("wires the existing $name id to the common retention and retirement boundary", async ({ element }) => {
    const rendered = render(element("/a.png", "one"))
    const original = sourceImage(rendered.container, "/a.png")
    await makeReady(original)
    rendered.rerender(element("/b.png", "one"))
    expect(original.isConnected).toBe(true)
    expect(original).toHaveClass("opacity-100")
    rendered.rerender(element("/b.png", "two"))
    expect(original.isConnected).toBe(false)
    expect(rendered.container.querySelectorAll("img")).toHaveLength(1)
  })

  it("keeps remote URLs inert while rendering a share preparation tree", () => {
    const rendered = render(React.createElement(ShareImagePreparationContext, { value: true },
      React.createElement(RemoteIdentityImage, { src: "/avatar.png", alt: "Ada" }),
      React.createElement(RemoteContentImage, { src: "/attachment.png", alt: "Photo" }),
      React.createElement(RemoteMarkdownImage, { src: "/markdown.png", alt: "Diagram" }),
    ))
    const images = [...rendered.container.querySelectorAll("img")]
    expect(images).toHaveLength(3)
    expect(images.map((image) => image.getAttribute("data-share-image-src")))
      .toEqual(["/avatar.png", "/attachment.png", "/markdown.png"])
    expect(images.every((image) => !image.hasAttribute("src"))).toBe(true)
  })

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

  it("recovers an offline identity image on online with the exact URL and fences its old decode", async () => {
    let finishOldDecode!: () => void
    const oldDecode = new Promise<void>((resolve) => { finishOldDecode = resolve })
    const rendered = render(React.createElement(RemoteIdentityImage, { src: "/avatar/peer?v=3", alt: "Peer", profilePhoto: true }))
    const identity = () => rendered.container.querySelector<HTMLImageElement>('[data-remote-image-kind="identity"]')!
    const original = identity()
    setImageMetrics(original, () => oldDecode)
    fireEvent.load(original)
    fireEvent.error(original)
    expect(original).toHaveAttribute("data-avatar-photo-state", "failed")

    fireEvent(window, new Event("online"))
    const retried = identity()
    expect(retried).toBe(original)
    expect(retried).toHaveAttribute("src", "/avatar/peer?v=3")
    expect(retried).toHaveAttribute("data-avatar-photo-state", "pending")
    await act(async () => { finishOldDecode(); await oldDecode })
    expect(retried).toHaveAttribute("data-avatar-photo-state", "pending")

    const decode = vi.fn(async () => {})
    setImageMetrics(retried, decode)
    fireEvent.load(retried)
    await act(async () => { await Promise.resolve() })
    expect(decode).toHaveBeenCalledOnce()
    expect(retried).toHaveAttribute("data-avatar-photo-state", "ready")
    expect(retried.naturalWidth).toBeGreaterThan(0)
    fireEvent(window, new Event("online"))
    expect(identity()).toBe(retried)
  })

  it("restarts a pending identity attempt on online and removes its listener on exit", () => {
    const added = vi.spyOn(window, "addEventListener")
    const removed = vi.spyOn(window, "removeEventListener")
    try {
      const rendered = render(React.createElement(RemoteIdentityImage, { src: "/avatar/peer?v=3", alt: "Peer" }))
      const original = rendered.container.querySelector<HTMLImageElement>("img")!
      fireEvent(window, new Event("online"))
      const retried = rendered.container.querySelector<HTMLImageElement>("img")!
      expect(retried).toBe(original)
      expect(retried).toHaveAttribute("src", "/avatar/peer?v=3")
      expect(retried).toHaveAttribute("data-remote-image-state", "pending")
      const online = added.mock.calls.find(([name]) => name === "online")![1]
      rendered.unmount()
      expect(removed).toHaveBeenCalledWith("online", online)
      fireEvent(window, new Event("online"))
      expect(rendered.container).toBeEmptyDOMElement()
    } finally { added.mockRestore(); removed.mockRestore() }
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

  it.each([
    { name: "identity", element: () => React.createElement(RemoteIdentityImage, { src: "/slow-avatar.png", alt: "Avatar" }) },
    { name: "eager content", element: () => React.createElement(RemoteContentImage, { src: "/slow-eager.png", alt: "Eager", loading: "eager" }) },
    { name: "lazy content", element: () => React.createElement(RemoteContentImage, { src: "/slow-lazy.png", alt: "Lazy", loading: "lazy" }) },
    { name: "Markdown", element: () => React.createElement(RemoteMarkdownImage, { src: "/slow-markdown.png", alt: "Markdown" }) },
  ])("keeps $name pending beyond five seconds and reveals its late decoded success", async ({ element }) => {
    vi.useFakeTimers()
    let finishDecode!: () => void
    const decode = new Promise<void>((resolve) => { finishDecode = resolve })
    const owner = createApplicationOwner("slow-image-viewer")
    const rendered = render(React.createElement(ApplicationOwnerProvider, { owner }, element()))
    const image = rendered.container.querySelector<HTMLImageElement>("img")!
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(image).toHaveAttribute("data-remote-image-state", "pending")
    expect(image).toHaveClass("opacity-0")
    expect(rendered.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument()

    setImageMetrics(image, () => decode)
    fireEvent.load(image)
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(image).toHaveAttribute("data-remote-image-state", "pending")
    await act(async () => { finishDecode(); await decode })
    expect(image).toHaveAttribute("data-remote-image-state", "ready")
    expect(image).toHaveClass("opacity-100")
    rendered.unmount()
    owner.queryClient.clear()
  })

  it("keeps lazy loading native while a real decode failure remains retryable", async () => {
    const rendered = render(React.createElement(RemoteContentImage, { src: "/decode.png", alt: "Photo", loading: "lazy" }))
    const image = contentImage(rendered.container)
    expect(image).toHaveAttribute("loading", "lazy")
    setImageMetrics(image, () => Promise.reject(new Error("decode failed")))
    fireEvent.load(image)
    await act(async () => { await Promise.resolve() })
    expect(image).toHaveAttribute("data-remote-image-state", "error")
    fireEvent.click(rendered.getByRole("button", { name: "Retry" }))
    expect(contentImage(rendered.container)).toHaveAttribute("src", "/decode.png")
    expect(contentImage(rendered.container)).toHaveAttribute("data-remote-image-state", "pending")
  })

  it("ignores a late decoded success after the source changes", async () => {
    let finishOldDecode!: () => void
    const oldDecode = new Promise<void>((resolve) => { finishOldDecode = resolve })
    const element = (src: string) => React.createElement(RemoteContentImage, { src, alt: "Photo" })
    const rendered = render(element("/old.png"))
    const oldImage = contentImage(rendered.container)
    setImageMetrics(oldImage, () => oldDecode)
    fireEvent.load(oldImage)
    rendered.rerender(element("/new.png"))
    await act(async () => { finishOldDecode(); await oldDecode })
    const current = contentImage(rendered.container)
    expect(current).toHaveAttribute("src", "/new.png")
    expect(current).toHaveAttribute("data-remote-image-state", "pending")
    setImageMetrics(current)
    fireEvent.load(current)
    await act(async () => { await Promise.resolve() })
    expect(current).toHaveAttribute("data-remote-image-state", "ready")
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
