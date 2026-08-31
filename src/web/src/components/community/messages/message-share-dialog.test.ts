import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import {
  MessageShareDialog,
  ShareCardImageTimeoutError,
  ShareImageSnapshotError,
  copyRenderedShareCard,
  createShareImageSnapshot,
  downloadRenderedShareCard,
  renderShareCard,
  snapshotShareCardImages,
  waitForShareCardImages,
} from "./message-share-dialog"
import type { RenderMsg } from "@/lib/community/models/message"

const profileState = vi.hoisted(() => ({ map: new Map<string, Record<string, unknown>>() }))
vi.mock("@/stores/community/ws", () => ({
  useProfilesByUserId: () => profileState.map,
}))

vi.mock("html-to-image", () => ({ toBlob: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("next/image", () => ({ default: "img" }))
vi.mock("../avatar", () => ({ Avatar: "mock-avatar" }))
vi.mock("./message-body", () => ({
  MessageBody: (props: { text: string }) => (
    React.createElement("mock-message-body", props)
  ),
}))
vi.mock("@/components/ui/button", () => ({ Button: "button" }))
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => children
  return {
    Dialog: Passthrough,
    DialogContent: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  }
})

function message(overrides: Partial<RenderMsg> = {}): RenderMsg {
  return {
    id: "m1",
    type: "chat",
    authorId: "u1",
    authorName: "Alice",
    content: "Current message",
    grouped: false,
    ...overrides,
  }
}

function renderMessage(m: RenderMsg) {
  profileState.map = new Map()
  if (m.authorId) {
    profileState.map.set(m.authorId, {
      id: m.authorId,
      name: m.authorName,
      ...(m.authorAvatar ? { avatar: m.authorAvatar } : {}),
      avatarVersion: m.authorAvatarVersion ?? 0,
    })
  }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(React.createElement(MessageShareDialog, {
      m,
      open: true,
      onClose: vi.fn(),
    }))
  })
  return renderer!
}

describe("MessageShareDialog message context", () => {
  it("passes the custom avatar URL as an image source, not as fallback copy", () => {
    const renderer = renderMessage(message({ authorAvatar: "/api/community/users/u1/avatar" }))
    const avatar = renderer.root.findByType("mock-avatar")
    expect(avatar.props).toMatchObject({
      label: "Alice",
      src: "/api/community/users/u1/avatar",
      seed: "u1",
    })
  })

  it("renders the reply author and plain-text excerpt above the shared message", () => {
    const renderer = renderMessage(message({
      replyTo: {
        id: "original",
        authorName: "Bob",
        text: "A **formatted** reply",
      },
    }))

    const reply = renderer.root.findByProps({ "data-testid": "message-share-reply-m1" })
    const spans = reply.findAllByType("span")
    expect(spans.map((span) => span.children.join(""))).toEqual([
      "@Bob",
      "A formatted reply",
    ])
  })

  it("keeps the reply header while sharing only projected message content", () => {
    const renderer = renderMessage(message({
      content: "@Bob Smith\n**visible** body",
      replyTo: {
        id: "original",
        authorName: "Bob Smith",
        text: "Original body",
      },
    }))

    expect(renderer.root.findByType("mock-message-body").props.text).toBe("**visible** body")
    const reply = renderer.root.findByProps({ "data-testid": "message-share-reply-m1" })
    expect(reply.findAllByType("span").map((span) => span.children.join(""))).toEqual([
      "@Bob Smith",
      "Original body",
    ])
  })

  it("omits a standalone body for an attachment-only canonical reply", () => {
    const renderer = renderMessage(message({
      content: "@Bob\n",
      replyTo: { id: "original", authorName: "Bob", text: "Original body" },
      attachments: [{ kind: "image", name: "photo.png", url: "/photo.png" }],
    }))

    expect(renderer.root.findAllByType("mock-message-body")).toHaveLength(0)
    expect(renderer.root.findByProps({ "data-testid": "message-share-image-m1-0" })).toBeDefined()
  })

  it("renders the deleted-original state without stale reply details", () => {
    const renderer = renderMessage(message({
      replyTo: {
        id: "original",
        authorName: "Bob",
        text: "Stale content",
        deleted: true,
      },
    }))

    const reply = renderer.root.findByProps({ "data-testid": "message-share-reply-m1" })
    const text = reply.findAllByType("span").map((span) => span.children.join(""))
    expect(text).toEqual(["Original message was deleted"])
  })

  it("renders every emoji reaction with its count", () => {
    const renderer = renderMessage(message({
      reactions: [
        { emoji: "👍", count: 2, me: true, userIds: ["u1", "u2"] },
        { emoji: "🎉", count: 11, me: false, userIds: [] },
      ],
    }))

    const reactions = renderer.root.findByProps({ "data-testid": "message-share-reactions-m1" })
    const text = reactions.findAllByType("span").map((span) => span.children.join(""))
    expect(text).toEqual(expect.arrayContaining(["👍", "2", "🎉", "11"]))
  })

  it("renders attached originals at their intrinsic ratio and omits files", () => {
    const renderer = renderMessage(message({
      attachments: [
        {
          kind: "image",
          name: "photo.png",
          url: "/original-photo.png",
          thumbnailUrl: "/thumbnail-photo.jpg",
          width: 1200,
          height: 800,
        },
        { kind: "file", name: "notes.txt", url: "/notes.txt", size: "1 KB" },
      ],
    }))

    const image = renderer.root.findByProps({ "data-testid": "message-share-image-m1-0" })
    expect(image.props).toMatchObject({
      src: "/original-photo.png",
      alt: "photo.png",
      width: 1200,
      height: 800,
      loading: "eager",
      style: { aspectRatio: "1200/800" },
    })
    expect(image.props.className).toContain("max-h-75")
    expect(image.props.className).toContain("max-w-full")
    expect(image.props.className).toContain("rounded-lg")
    expect(image.props.className).toContain("object-contain")
    expect(image.parent?.props.className).toContain("w-fit")
    expect(image.parent?.props.className).toContain("max-w-full")
    expect(image.parent?.props.className).toContain("rounded-lg")
    expect(image.parent?.props.className).toContain("border")
    expect(renderer.root.findAllByProps({ src: "/notes.txt" })).toHaveLength(0)
  })

  it("keeps image previews above reactions like the live message", () => {
    const renderer = renderMessage(message({
      content: "",
      attachments: [{ kind: "image", name: "photo.png", url: "/photo.png" }],
      reactions: [{ emoji: "👍", count: 2, me: false, userIds: [] }],
    }))

    const contextOrder = renderer.root.findAll((node) => (
      typeof node.props["data-testid"] === "string"
      && ["message-share-images-m1", "message-share-reactions-m1"].includes(node.props["data-testid"])
    )).map((node) => node.props["data-testid"])
    expect(contextOrder).toEqual(["message-share-images-m1", "message-share-reactions-m1"])
  })

  it("does not add empty context containers", () => {
    const renderer = renderMessage(message())
    const contexts = renderer.root.findAll((node) => (
      typeof node.props["data-testid"] === "string"
      && node.props["data-testid"].startsWith("message-share-")
    ))
    expect(contexts).toHaveLength(0)
  })
})

describe("waitForShareCardImages", () => {
  function image(overrides: Partial<HTMLImageElement> = {}) {
    const listeners = new Map<string, () => void>()
    const value = {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      decode: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      ...overrides,
    } as unknown as HTMLImageElement
    return { value, listeners }
  }

  function card(images: HTMLImageElement[]): HTMLElement {
    return { querySelectorAll: () => images } as unknown as HTMLElement
  }

  it("waits for a pending avatar load, decodes it, and yields a paint", async () => {
    const avatar = image()
    const paint = vi.fn().mockResolvedValue(undefined)
    const waiting = waitForShareCardImages(card([avatar.value]), paint)

    expect(paint).not.toHaveBeenCalled()
    Object.defineProperty(avatar.value, "naturalWidth", { value: 40 })
    Object.defineProperty(avatar.value, "naturalHeight", { value: 40 })
    avatar.listeners.get("load")?.()
    await waiting

    expect(avatar.value.decode).toHaveBeenCalledOnce()
    expect(paint).toHaveBeenCalledOnce()
  })

  it("rejects an image error before paint so capture cannot snapshot an empty branch", async () => {
    const avatar = image()
    const paint = vi.fn().mockResolvedValue(undefined)
    const waiting = waitForShareCardImages(card([avatar.value]), paint)
    avatar.listeners.get("error")?.()
    await expect(waiting).rejects.toBeInstanceOf(ShareImageSnapshotError)

    expect(avatar.value.decode).not.toHaveBeenCalled()
    expect(paint).not.toHaveBeenCalled()
  })

  it("decodes an already-loaded cached avatar without waiting for another event", async () => {
    const avatar = image({ complete: true, naturalWidth: 40, naturalHeight: 40 })
    const paint = vi.fn().mockResolvedValue(undefined)
    await waitForShareCardImages(card([avatar.value]), paint)

    expect(avatar.value.addEventListener).not.toHaveBeenCalled()
    expect(avatar.value.decode).toHaveBeenCalledOnce()
    expect(paint).toHaveBeenCalledOnce()
  })

  it("rejects a pending-forever image within the bound and removes its listeners", async () => {
    vi.useFakeTimers()
    try {
      const avatar = image()
      const paint = vi.fn().mockResolvedValue(undefined)
      const waiting = waitForShareCardImages(card([avatar.value]), paint, 50)
      const rejected = expect(waiting).rejects.toBeInstanceOf(ShareCardImageTimeoutError)

      await vi.advanceTimersByTimeAsync(50)
      await rejected

      expect(avatar.value.removeEventListener).toHaveBeenCalledWith("load", expect.any(Function))
      expect(avatar.value.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function))
      expect(paint).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds a pending-forever decode and degrades to the loaded bitmap", async () => {
    vi.useFakeTimers()
    try {
      const avatar = image({
        complete: true,
        naturalWidth: 40,
        naturalHeight: 40,
        decode: vi.fn(() => new Promise<void>(() => {})),
      })
      const paint = vi.fn().mockResolvedValue(undefined)
      const waiting = waitForShareCardImages(card([avatar.value]), paint, 50)

      await vi.advanceTimersByTimeAsync(50)
      await waiting

      expect(avatar.value.decode).toHaveBeenCalledOnce()
      expect(paint).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("snapshotShareCardImages", () => {
  function image() {
    return { replaceWith: vi.fn() } as unknown as HTMLImageElement
  }

  function canvas() {
    return {
      parentNode: {},
      replaceWith: vi.fn(),
    } as unknown as HTMLCanvasElement
  }

  function card(images: HTMLImageElement[]): HTMLElement {
    return { querySelectorAll: () => images } as unknown as HTMLElement
  }

  it("replaces every live image with its local canvas snapshot and restores it", async () => {
    const avatar = image()
    const attachment = image()
    const avatarCanvas = canvas()
    const attachmentCanvas = canvas()
    const createSnapshot = vi.fn()
      .mockReturnValueOnce(avatarCanvas)
      .mockReturnValueOnce(attachmentCanvas)
    const waitForImages = vi.fn().mockResolvedValue(undefined)
    const waitForPaint = vi.fn().mockResolvedValue(undefined)

    const restore = await snapshotShareCardImages(
      card([avatar, attachment]),
      createSnapshot,
      waitForImages,
      waitForPaint,
    )

    expect(waitForImages).toHaveBeenCalledOnce()
    expect(createSnapshot).toHaveBeenNthCalledWith(1, avatar)
    expect(createSnapshot).toHaveBeenNthCalledWith(2, attachment)
    expect(avatar.replaceWith).toHaveBeenCalledWith(avatarCanvas)
    expect(attachment.replaceWith).toHaveBeenCalledWith(attachmentCanvas)
    expect(waitForPaint).toHaveBeenCalledOnce()

    restore()
    restore()
    expect(avatarCanvas.replaceWith).toHaveBeenCalledOnce()
    expect(avatarCanvas.replaceWith).toHaveBeenCalledWith(avatar)
    expect(attachmentCanvas.replaceWith).toHaveBeenCalledOnce()
    expect(attachmentCanvas.replaceWith).toHaveBeenCalledWith(attachment)
  })

  it("supports consecutive captures of the same React-owned images", async () => {
    const avatar = image()
    const firstCanvas = canvas()
    const secondCanvas = canvas()
    const createSnapshot = vi.fn()
      .mockReturnValueOnce(firstCanvas)
      .mockReturnValueOnce(secondCanvas)
    const waitForImages = vi.fn().mockResolvedValue(undefined)
    const waitForPaint = vi.fn().mockResolvedValue(undefined)

    const restoreFirst = await snapshotShareCardImages(
      card([avatar]),
      createSnapshot,
      waitForImages,
      waitForPaint,
    )
    restoreFirst()
    const restoreSecond = await snapshotShareCardImages(
      card([avatar]),
      createSnapshot,
      waitForImages,
      waitForPaint,
    )
    restoreSecond()

    expect(createSnapshot).toHaveBeenCalledTimes(2)
    expect(avatar.replaceWith).toHaveBeenNthCalledWith(1, firstCanvas)
    expect(avatar.replaceWith).toHaveBeenNthCalledWith(2, secondCanvas)
    expect(firstCanvas.replaceWith).toHaveBeenCalledWith(avatar)
    expect(secondCanvas.replaceWith).toHaveBeenCalledWith(avatar)
  })

  it("restores every replaced image when the snapshot paint fails", async () => {
    const avatar = image()
    const attachment = image()
    const avatarCanvas = canvas()
    const attachmentCanvas = canvas()
    const createSnapshot = vi.fn()
      .mockReturnValueOnce(avatarCanvas)
      .mockReturnValueOnce(attachmentCanvas)

    await expect(
      snapshotShareCardImages(
        card([avatar, attachment]),
        createSnapshot,
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockRejectedValue(new Error("paint failed")),
      ),
    ).rejects.toThrow("paint failed")

    expect(avatarCanvas.replaceWith).toHaveBeenCalledWith(avatar)
    expect(attachmentCanvas.replaceWith).toHaveBeenCalledWith(attachment)
  })

  it("restores earlier images when a later snapshot fails", async () => {
    const avatar = image()
    const attachment = image()
    const avatarCanvas = canvas()
    const createSnapshot = vi.fn()
      .mockReturnValueOnce(avatarCanvas)
      .mockImplementationOnce(() => { throw new ShareImageSnapshotError() })

    await expect(
      snapshotShareCardImages(
        card([avatar, attachment]),
        createSnapshot,
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toBeInstanceOf(ShareImageSnapshotError)

    expect(avatarCanvas.replaceWith).toHaveBeenCalledWith(avatar)
  })

  it("aborts capture instead of replacing a tainted image with a blank canvas", () => {
    const drawImage = vi.fn()
    const canvas = {
      className: "",
      style: { cssText: "", width: "", height: "" },
      setAttribute: vi.fn(),
      getContext: vi.fn(() => ({ drawImage })),
      toDataURL: vi.fn(() => { throw new Error("tainted") }),
    }
    const createElement = vi.fn(() => canvas)
    vi.stubGlobal("document", { createElement })
    vi.stubGlobal("getComputedStyle", () => ({ objectFit: "cover" }))

    expect(() => createShareImageSnapshot({
      naturalWidth: 512,
      naturalHeight: 512,
      className: "rounded-full",
      style: { cssText: "" },
      attributes: [],
      getBoundingClientRect: () => ({ width: 40, height: 40 }),
    } as unknown as HTMLImageElement)).toThrow(ShareImageSnapshotError)

    expect(drawImage).toHaveBeenCalledOnce()
    expect(canvas.toDataURL).toHaveBeenCalledOnce()
    expect(createElement).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it.each([
    { name: "zero intrinsic size", naturalWidth: 0, naturalHeight: 0, context: { drawImage: vi.fn() } },
    { name: "missing 2D context", naturalWidth: 512, naturalHeight: 512, context: null },
  ])("rejects $name instead of returning a blank canvas", ({ naturalWidth, naturalHeight, context }) => {
    const canvas = {
      className: "",
      style: { cssText: "", width: "", height: "" },
      setAttribute: vi.fn(),
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(),
    }
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) })
    vi.stubGlobal("getComputedStyle", () => ({ objectFit: "cover" }))

    expect(() => createShareImageSnapshot({
      naturalWidth,
      naturalHeight,
      className: "rounded-full",
      style: { cssText: "" },
      attributes: [],
      getBoundingClientRect: () => ({ width: 40, height: 40 }),
    } as unknown as HTMLImageElement)).toThrow(ShareImageSnapshotError)

    expect(canvas.toDataURL).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("skips a zero-size image while snapshotting the remaining images", async () => {
    const hiddenImage = image()
    const attachment = image()
    const attachmentCanvas = canvas()
    const createSnapshot = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(attachmentCanvas)

    const restore = await snapshotShareCardImages(
      card([hiddenImage, attachment]),
      createSnapshot,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    )

    expect(hiddenImage.replaceWith).not.toHaveBeenCalled()
    expect(attachment.replaceWith).toHaveBeenCalledWith(attachmentCanvas)
    restore()
    expect(attachmentCanvas.replaceWith).toHaveBeenCalledWith(attachment)
  })
})

describe("renderShareCard", () => {
  it("does not rasterize when image snapshot preparation fails", async () => {
    const node = {} as HTMLElement
    const snapshotImages = vi.fn().mockRejectedValue(new ShareImageSnapshotError())
    const rasterize = vi.fn()

    await expect(renderShareCard(node, snapshotImages, rasterize)).rejects.toThrow(
      ShareImageSnapshotError,
    )

    expect(rasterize).not.toHaveBeenCalled()
  })

  it("does not reach clipboard or download writes when snapshot preparation fails", async () => {
    const failure = new ShareImageSnapshotError()
    const render = vi.fn().mockRejectedValue(failure)
    const clipboardWrite = vi.fn()
    const downloadSave = vi.fn()

    await expect(copyRenderedShareCard(render, clipboardWrite)).rejects.toBe(failure)
    await expect(downloadRenderedShareCard(render, "share.png", downloadSave)).rejects.toBe(failure)

    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(downloadSave).not.toHaveBeenCalled()
  })
})
