import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import {
  MessageShareDialog,
  ShareCardImageTimeoutError,
  ShareCardRenderError,
  ShareImageSnapshotError,
  type ShareCardImageDisposition,
  copyRenderedShareCard,
  createShareImageSnapshot,
  downloadRenderedShareCard,
  renderShareCard,
  shareCardRenderErrorMessage,
  snapshotShareCardImages,
  waitForShareCardImages,
  writeShareCardToClipboard,
} from "./message-share-dialog"
import type { RenderMsg } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"

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

function renderMessage(
  m: RenderMsg,
  options: TestRenderer.TestRendererOptions = {},
) {
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
    renderer = TestRenderer.create(
      React.createElement(MessageShareDialog, {
        m,
        open: true,
        onClose: vi.fn(),
      }),
      options,
    )
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
  function image(
    overrides: Partial<HTMLImageElement> = {},
    {
      profilePhoto = false,
      photoState = "pending",
      remoteKind,
      remoteState = "pending",
    }: {
      profilePhoto?: boolean
      photoState?: "pending" | "ready" | "failed"
      remoteKind?: "identity" | "content"
      remoteState?: "pending" | "ready" | "error"
    } = {},
  ) {
    const listeners = new Map<string, () => void>()
    const value = {
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      decode: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string) => listeners.delete(type)),
      hasAttribute: vi.fn((name: string) => profilePhoto && name === "data-avatar-photo-state"),
      getAttribute: vi.fn((name: string) => {
        if (profilePhoto && name === "data-avatar-photo-state") return photoState
        if (name === "data-remote-image-kind") return remoteKind ?? null
        if (name === "data-remote-image-state") return remoteKind ? remoteState : null
        return null
      }),
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

  it("degrades a profile-photo error to its fallback disposition", async () => {
    const avatar = image({}, { profilePhoto: true })
    const paint = vi.fn().mockResolvedValue(undefined)
    const waiting = waitForShareCardImages(card([avatar.value]), paint)
    avatar.listeners.get("error")?.()

    await expect(waiting).resolves.toEqual([
      { image: avatar.value, mode: "fallback" },
    ])
    expect(avatar.value.decode).not.toHaveBeenCalled()
    expect(paint).toHaveBeenCalledOnce()
  })

  it("immediately degrades an already-failed profile photo without waiting again", async () => {
    const avatar = image({}, { profilePhoto: true, photoState: "failed" })
    const paint = vi.fn().mockResolvedValue(undefined)

    await expect(waitForShareCardImages(card([avatar.value]), paint)).resolves.toEqual([
      { image: avatar.value, mode: "fallback" },
    ])

    expect(avatar.value.addEventListener).not.toHaveBeenCalled()
    expect(avatar.value.decode).not.toHaveBeenCalled()
    expect(paint).toHaveBeenCalledOnce()
  })

  it("degrades a failed shared identity image without exposing substitute pixels", async () => {
    const avatar = image({}, { remoteKind: "identity", remoteState: "error" })
    const paint = vi.fn().mockResolvedValue(undefined)

    await expect(waitForShareCardImages(card([avatar.value]), paint)).resolves.toEqual([
      { image: avatar.value, mode: "fallback" },
    ])
    expect(avatar.value.addEventListener).not.toHaveBeenCalled()
    expect(paint).toHaveBeenCalledOnce()
  })

  it("rejects a failed shared content image before rasterization", async () => {
    const attachment = image({}, { remoteKind: "content", remoteState: "error" })
    const paint = vi.fn().mockResolvedValue(undefined)

    await expect(waitForShareCardImages(card([attachment.value]), paint))
      .rejects.toBeInstanceOf(ShareImageSnapshotError)
    expect(attachment.value.addEventListener).not.toHaveBeenCalled()
    expect(paint).not.toHaveBeenCalled()
  })

  it("rejects native pixels that remain pending in the shared content lifecycle", async () => {
    const attachment = image({
      complete: true,
      naturalWidth: 96,
      naturalHeight: 64,
    }, { remoteKind: "content", remoteState: "pending" })
    const paint = vi.fn().mockResolvedValue(undefined)

    await expect(waitForShareCardImages(card([attachment.value]), paint))
      .rejects.toBeInstanceOf(ShareImageSnapshotError)
    expect(attachment.value.decode).toHaveBeenCalledOnce()
    expect(paint).toHaveBeenCalledOnce()
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

  it("degrades a pending-forever profile photo within the shared bound", async () => {
    vi.useFakeTimers()
    try {
      const avatar = image({}, { profilePhoto: true })
      const attachment = image({ complete: true, naturalWidth: 96, naturalHeight: 64 })
      const paint = vi.fn().mockResolvedValue(undefined)
      const waiting = waitForShareCardImages(card([avatar.value, attachment.value]), paint, 50)

      await vi.advanceTimersByTimeAsync(50)
      await expect(waiting).resolves.toEqual([
        { image: avatar.value, mode: "fallback" },
        { image: attachment.value, mode: "snapshot" },
      ])

      expect(attachment.value.decode).toHaveBeenCalledOnce()
      expect(avatar.value.removeEventListener).toHaveBeenCalledWith("load", expect.any(Function))
      expect(avatar.value.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function))
      expect(paint).toHaveBeenCalledOnce()
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

  it.each([
    ["rejects", vi.fn().mockRejectedValue(new Error("decode failed"))],
    ["times out", vi.fn(() => new Promise<void>(() => {}))],
  ])("degrades a profile photo when decode %s", async (_name, decode) => {
    vi.useFakeTimers()
    try {
      const avatar = image({
        complete: true,
        naturalWidth: 40,
        naturalHeight: 40,
        decode,
      }, { profilePhoto: true })
      const paint = vi.fn().mockResolvedValue(undefined)
      const waiting = waitForShareCardImages(card([avatar.value]), paint, 50)

      await vi.advanceTimersByTimeAsync(50)
      await expect(waiting).resolves.toEqual([
        { image: avatar.value, mode: "fallback" },
      ])
      expect(paint).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it("aborts a pending image wait and removes every listener", async () => {
    const avatar = image({}, { profilePhoto: true })
    const paint = vi.fn().mockResolvedValue(undefined)
    const controller = new AbortController()
    const waiting = waitForShareCardImages(card([avatar.value]), paint, 50, controller.signal)

    controller.abort()

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    expect(avatar.value.removeEventListener).toHaveBeenCalledWith("load", expect.any(Function))
    expect(avatar.value.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function))
    expect(paint).not.toHaveBeenCalled()
  })
})

describe("snapshotShareCardImages", () => {
  function image() {
    return { parentNode: {}, replaceWith: vi.fn() } as unknown as HTMLImageElement
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

  function prepared(
    images: HTMLImageElement[],
    mode: ShareCardImageDisposition["mode"] = "snapshot",
  ): ShareCardImageDisposition[] {
    return images.map((image) => ({ image, mode }))
  }

  it("replaces every live image with its local canvas snapshot and restores it", async () => {
    const avatar = image()
    const attachment = image()
    const avatarCanvas = canvas()
    const attachmentCanvas = canvas()
    const createSnapshot = vi.fn()
      .mockReturnValueOnce(avatarCanvas)
      .mockReturnValueOnce(attachmentCanvas)
    const waitForImages = vi.fn().mockResolvedValue(prepared([avatar, attachment]))
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
    const waitForImages = vi.fn().mockResolvedValue(prepared([avatar]))
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
        vi.fn().mockResolvedValue(prepared([avatar, attachment])),
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
        vi.fn().mockResolvedValue(prepared([avatar, attachment])),
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
      vi.fn().mockResolvedValue(prepared([hiddenImage, attachment])),
      vi.fn().mockResolvedValue(undefined),
    )

    expect(hiddenImage.replaceWith).not.toHaveBeenCalled()
    expect(attachment.replaceWith).toHaveBeenCalledWith(attachmentCanvas)
    restore()
    expect(attachmentCanvas.replaceWith).toHaveBeenCalledWith(attachment)
  })

  it("suppresses a pending profile photo so the neutral placeholder DOM is rasterized", async () => {
    const avatar = image()
    const placeholder = {
      hidden: false,
      parentNode: {},
      replaceWith: vi.fn(),
    }
    const createSnapshot = vi.fn()
    vi.stubGlobal("document", { createElement: vi.fn(() => placeholder) })

    try {
      const restore = await snapshotShareCardImages(
        card([avatar]),
        createSnapshot,
        vi.fn().mockResolvedValue(prepared([avatar], "fallback")),
        vi.fn().mockResolvedValue(undefined),
      )

      expect(createSnapshot).not.toHaveBeenCalled()
      expect(placeholder.hidden).toBe(true)
      expect(avatar.replaceWith).toHaveBeenCalledWith(placeholder)

      restore()
      restore()
      expect(placeholder.replaceWith).toHaveBeenCalledOnce()
      expect(placeholder.replaceWith).toHaveBeenCalledWith(avatar)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("renderShareCard", () => {
  const node = {} as HTMLElement
  const style = { getPropertyValue: vi.fn(() => "") }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("records the complete render lifecycle and restores snapshots once", async () => {
    vi.stubGlobal("getComputedStyle", vi.fn(() => style))
    const stages: string[] = []
    const restore = vi.fn()
    const blob = new Blob(["png"], { type: "image/png" })
    const snapshotImages = vi.fn().mockResolvedValue(restore)
    const loadFonts = vi.fn().mockResolvedValue(undefined)
    const rasterize = vi.fn().mockResolvedValue(blob)

    await expect(renderShareCard(node, snapshotImages, rasterize, {
      loadFonts,
      onStage: (stage) => stages.push(stage),
    })).resolves.toBe(blob)

    expect(stages).toEqual(["snapshot", "fonts", "rasterize", "cleanup"])
    expect(loadFonts).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  it("types snapshot preparation failures and skips rasterization", async () => {
    const failure = new ShareImageSnapshotError()
    const snapshotImages = vi.fn().mockRejectedValue(failure)
    const rasterize = vi.fn()

    await expect(renderShareCard(node, snapshotImages, rasterize, {
      loadFonts: vi.fn(),
    })).rejects.toMatchObject({
      stage: "snapshot",
      timedOut: false,
      cause: failure,
    })

    expect(rasterize).not.toHaveBeenCalled()
  })

  it("keeps font loading best-effort and proceeds to rasterization", async () => {
    vi.stubGlobal("getComputedStyle", vi.fn(() => style))
    const restore = vi.fn()
    const blob = new Blob(["png"], { type: "image/png" })
    const rasterize = vi.fn().mockResolvedValue(blob)

    await expect(renderShareCard(
      node,
      vi.fn().mockResolvedValue(restore),
      rasterize,
      { loadFonts: vi.fn().mockRejectedValue(new Error("font unavailable")) },
    )).resolves.toBe(blob)

    expect(rasterize).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  it("uses the real document font contract when no font waiter is injected", async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    const ready = Promise.resolve()
    vi.stubGlobal("document", { documentElement: {}, fonts: { load, ready } })
    vi.stubGlobal("getComputedStyle", vi.fn((target) => (
      target === document.documentElement
        ? { getPropertyValue: vi.fn(() => "Caveat") }
        : style
    )))

    await renderShareCard(
      node,
      vi.fn().mockResolvedValue(vi.fn()),
      vi.fn().mockResolvedValue(new Blob(["png"])),
    )

    expect(load).toHaveBeenCalledWith("16px Caveat")
  })

  it.each([
    {
      name: "a rejected rasterizer",
      result: () => Promise.reject(new Error("raster failed")),
    },
    {
      name: "a null rasterizer result",
      result: () => Promise.resolve(null),
    },
  ])("types $name and restores snapshots once", async ({ result }) => {
    vi.stubGlobal("getComputedStyle", vi.fn(() => style))
    const restore = vi.fn()

    await expect(renderShareCard(
      node,
      vi.fn().mockResolvedValue(restore),
      vi.fn(result),
      { loadFonts: vi.fn().mockResolvedValue(undefined) },
    )).rejects.toMatchObject({ stage: "rasterize", timedOut: false })

    expect(restore).toHaveBeenCalledOnce()
  })

  it.each(["snapshot", "fonts", "rasterize"] as const)(
    "applies the single total deadline while in %s",
    async (blockedStage) => {
      vi.useFakeTimers()
      vi.stubGlobal("getComputedStyle", vi.fn(() => style))
      const never = () => new Promise<never>(() => {})
      const restore = vi.fn()
      const snapshotImages = blockedStage === "snapshot"
        ? vi.fn(never)
        : vi.fn().mockResolvedValue(restore)
      const loadFonts = blockedStage === "fonts"
        ? vi.fn(never)
        : vi.fn().mockResolvedValue(undefined)
      const rasterize = blockedStage === "rasterize"
        ? vi.fn(never)
        : vi.fn().mockResolvedValue(new Blob(["png"]))
      const rendering = renderShareCard(node, snapshotImages, rasterize, {
        timeoutMs: 50,
        loadFonts,
      })
      const rejected = expect(rendering).rejects.toMatchObject({
        stage: blockedStage,
        timedOut: true,
      })

      await vi.advanceTimersByTimeAsync(50)
      await rejected

      expect(restore).toHaveBeenCalledTimes(blockedStage === "snapshot" ? 0 : 1)
    },
  )

  it("restores a late snapshot result after the caller deadline has fired", async () => {
    vi.useFakeTimers()
    let finishSnapshot: ((restore: () => void) => void) | undefined
    const restore = vi.fn()
    const snapshotImages = vi.fn(() => new Promise<() => void>((resolve) => {
      finishSnapshot = resolve
    }))
    const rasterize = vi.fn()
    const rendering = renderShareCard(node, snapshotImages, rasterize, {
      timeoutMs: 50,
      loadFonts: vi.fn(),
    })
    const rejected = expect(rendering).rejects.toMatchObject({
      stage: "snapshot",
      timedOut: true,
    })

    await vi.advanceTimersByTimeAsync(50)
    await rejected
    finishSnapshot?.(restore)
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())

    expect(rasterize).not.toHaveBeenCalled()
  })

  it("aborts a pending snapshot and restores its late result once", async () => {
    let finishSnapshot: ((restore: () => void) => void) | undefined
    const restore = vi.fn()
    const snapshotImages = vi.fn((_node: HTMLElement, signal?: AbortSignal) => (
      new Promise<() => void>((resolve) => {
        expect(signal?.aborted).toBe(false)
        finishSnapshot = resolve
      })
    ))
    const rasterize = vi.fn()
    const controller = new AbortController()
    const rendering = renderShareCard(node, snapshotImages, rasterize, {
      signal: controller.signal,
      loadFonts: vi.fn(),
    })
    const rejected = expect(rendering).rejects.toMatchObject({ name: "AbortError" })

    controller.abort()
    await rejected
    finishSnapshot?.(restore)
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())

    expect(rasterize).not.toHaveBeenCalled()
  })

  it("aborts an active rasterizer and restores snapshots exactly once", async () => {
    vi.stubGlobal("getComputedStyle", vi.fn(() => style))
    let finishRaster!: (blob: Blob) => void
    const restore = vi.fn()
    const rasterize = vi.fn(() => new Promise<Blob>((resolve) => {
      finishRaster = resolve
    }))
    const controller = new AbortController()
    const rendering = renderShareCard(
      node,
      vi.fn().mockResolvedValue(restore),
      rasterize,
      {
        signal: controller.signal,
        loadFonts: vi.fn().mockResolvedValue(undefined),
      },
    )
    const rejected = expect(rendering).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(rasterize).toHaveBeenCalledOnce())

    controller.abort()
    await rejected
    expect(restore).toHaveBeenCalledOnce()

    finishRaster(new Blob(["png"]))
    await Promise.resolve()
    expect(restore).toHaveBeenCalledOnce()
  })

  it.each(["fonts", "rasterize"] as const)(
    "stops after a late %s result and keeps cleanup exact",
    async (blockedStage) => {
      vi.useFakeTimers()
      vi.stubGlobal("getComputedStyle", vi.fn(() => style))
      let finishStage: (() => void) | undefined
      const restore = vi.fn()
      const loadFonts = blockedStage === "fonts"
        ? vi.fn(() => new Promise<void>((resolve) => { finishStage = resolve }))
        : vi.fn().mockResolvedValue(undefined)
      const rasterize = blockedStage === "rasterize"
        ? vi.fn(() => new Promise<Blob>((resolve) => {
            finishStage = () => resolve(new Blob(["png"]))
          }))
        : vi.fn().mockResolvedValue(new Blob(["png"]))
      const rendering = renderShareCard(
        node,
        vi.fn().mockResolvedValue(restore),
        rasterize,
        { timeoutMs: 50, loadFonts },
      )
      const outcome = rendering.catch((error) => error)

      await vi.advanceTimersByTimeAsync(50)
      expect(await outcome).toMatchObject({ stage: blockedStage, timedOut: true })
      finishStage?.()
      await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())

      expect(rasterize).toHaveBeenCalledTimes(blockedStage === "fonts" ? 0 : 1)
    },
  )

  it("surfaces cleanup failure when the deadline restores a blocked raster", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("getComputedStyle", vi.fn(() => style))
    const failure = new Error("restore failed")
    const restore = vi.fn(() => { throw failure })
    const rendering = renderShareCard(
      node,
      vi.fn().mockResolvedValue(restore),
      vi.fn(() => new Promise<never>(() => {})),
      { timeoutMs: 50, loadFonts: vi.fn().mockResolvedValue(undefined) },
    )
    const outcome = rendering.catch((error) => error)

    await vi.advanceTimersByTimeAsync(50)

    expect(await outcome).toMatchObject({
      stage: "cleanup",
      timedOut: false,
      cause: failure,
    })
    expect(restore).toHaveBeenCalledOnce()
  })

  it("types cleanup failures and never repeats the restore callback", async () => {
    vi.stubGlobal("getComputedStyle", vi.fn(() => style))
    const failure = new Error("restore failed")
    const restore = vi.fn(() => { throw failure })

    await expect(renderShareCard(
      node,
      vi.fn().mockResolvedValue(restore),
      vi.fn().mockResolvedValue(new Blob(["png"])),
      { loadFonts: vi.fn().mockResolvedValue(undefined) },
    )).rejects.toMatchObject({
      stage: "cleanup",
      timedOut: false,
      cause: failure,
    })

    expect(restore).toHaveBeenCalledOnce()
  })

  it("does not reach clipboard or download writers when rendering fails", async () => {
    const failure = new ShareCardRenderError("fonts", true)
    const render = vi.fn().mockRejectedValue(failure)
    const clipboardWrite = vi.fn()
    const downloadSave = vi.fn()

    await expect(copyRenderedShareCard(render, clipboardWrite)).rejects.toBe(failure)
    await expect(downloadRenderedShareCard(render, "share.png", downloadSave)).rejects.toBe(failure)

    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(downloadSave).not.toHaveBeenCalled()
  })

  it("types a renderer that resolves without a blob before action writers", async () => {
    const render = vi.fn().mockResolvedValue(null)
    const clipboardWrite = vi.fn()
    const downloadSave = vi.fn()

    await expect(copyRenderedShareCard(render, clipboardWrite)).rejects.toMatchObject({
      stage: "rasterize",
      timedOut: false,
    })
    await expect(downloadRenderedShareCard(render, "share.png", downloadSave)).rejects.toMatchObject({
      stage: "rasterize",
      timedOut: false,
    })

    expect(clipboardWrite).not.toHaveBeenCalled()
    expect(downloadSave).not.toHaveBeenCalled()
  })

  it("writes only after a completed render", async () => {
    const order: string[] = []
    const blob = new Blob(["png"], { type: "image/png" })
    const render = vi.fn(async () => {
      order.push("render")
      return blob
    })
    const clipboardWrite = vi.fn(() => { order.push("copy") })
    const downloadSave = vi.fn(() => { order.push("download") })

    await copyRenderedShareCard(render, clipboardWrite)
    await downloadRenderedShareCard(render, "share.png", downloadSave)

    expect(order).toEqual(["render", "copy", "render", "download"])
  })

  it.each([
    ["snapshot", "preparing images"],
    ["fonts", "loading fonts"],
    ["rasterize", "rendering the image"],
    ["cleanup", "restoring the preview"],
  ] as const)("formats visible %s stage failures", (stage, label) => {
    expect(shareCardRenderErrorMessage(new ShareCardRenderError(stage))).toBe(
      `Couldn't generate image — ${label} failed`,
    )
    expect(shareCardRenderErrorMessage(new ShareCardRenderError(stage, true))).toBe(
      `Couldn't generate image — ${label} took too long`,
    )
  })

  it("leaves post-render action errors to their action-specific UI", () => {
    expect(shareCardRenderErrorMessage(new Error("clipboard denied"))).toBeNull()
  })
})

describe("writeShareCardToClipboard", () => {
  class ClipboardItemStub {
    constructor(readonly items: Record<string, Blob>) {}
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("forwards PNG bytes once through the native desktop clipboard", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const webWrite = vi.fn()
    vi.stubGlobal("window", {
      __TAURI__: {},
      __TAURI_INTERNALS__: { invoke },
    })
    vi.stubGlobal("navigator", { userAgent: "Macintosh", clipboard: { write: webWrite } })
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

    await writeShareCardToClipboard(new Blob([bytes], { type: "image/png" }))

    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0][0]).toBe("plugin:clipboard-manager|write_image")
    expect([...new Uint8Array(invoke.mock.calls[0][1].image)]).toEqual([...bytes])
    expect(webWrite).not.toHaveBeenCalled()
  })

  it("does not retry WebKit after a native clipboard rejection", async () => {
    const failure = new Error("native clipboard rejected")
    const invoke = vi.fn().mockRejectedValue(failure)
    const webWrite = vi.fn()
    vi.stubGlobal("window", {
      __TAURI__: {},
      __TAURI_INTERNALS__: { invoke },
    })
    vi.stubGlobal("navigator", { userAgent: "Macintosh", clipboard: { write: webWrite } })

    await expect(writeShareCardToClipboard(new Blob(["png"]))).rejects.toBe(failure)

    expect(invoke).toHaveBeenCalledOnce()
    expect(webWrite).not.toHaveBeenCalled()
  })

  it("does not retry WebKit when the Tauri invoke bridge is missing", async () => {
    const webWrite = vi.fn()
    vi.stubGlobal("window", { __TAURI__: {} })
    vi.stubGlobal("navigator", { userAgent: "Macintosh", clipboard: { write: webWrite } })
    vi.stubGlobal("ClipboardItem", ClipboardItemStub)

    await expect(writeShareCardToClipboard(new Blob(["png"]))).rejects.toThrow()

    expect(webWrite).not.toHaveBeenCalled()
  })

  it.each([
    ["ordinary Web", {}, "Macintosh"],
    ["Tauri mobile", { __TAURI__: {} }, "iPhone"],
  ])("keeps %s on Web Clipboard", async (_surface, testWindow, userAgent) => {
    const webWrite = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("window", testWindow)
    vi.stubGlobal("navigator", { userAgent, clipboard: { write: webWrite } })
    vi.stubGlobal("ClipboardItem", ClipboardItemStub)

    await writeShareCardToClipboard(new Blob(["png"], { type: "image/png" }))

    expect(webWrite).toHaveBeenCalledOnce()
  })
})

describe("MessageShareDialog action feedback", () => {
  class ClipboardItemStub {
    constructor(readonly items: Record<string, Blob>) {}
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  function setupActionEnvironment(write = vi.fn().mockResolvedValue(undefined)) {
    const click = vi.fn()
    const createObjectURL = vi.fn(() => "blob:share-card")
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("window", { setTimeout, clearTimeout })
    vi.stubGlobal("navigator", { userAgent: "Macintosh", clipboard: { write } })
    vi.stubGlobal("ClipboardItem", ClipboardItemStub)
    vi.stubGlobal("document", {
      documentElement: {},
      fonts: { ready: Promise.resolve() },
      createElement: vi.fn(() => ({ click })),
    })
    vi.stubGlobal("getComputedStyle", vi.fn(() => ({
      getPropertyValue: vi.fn(() => ""),
    })))
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })
    const renderer = renderMessage(message(), {
      createNodeMock: () => ({ querySelectorAll: () => [] }),
    })
    const copyButton = renderer.root.findByProps({ "data-testid": tid.messageShareCopy })
    const downloadButton = renderer.root.findAllByType("button").find(
      (button) => button.children.includes("Download"),
    )!
    const dialog = renderer.root.find(
      (node) => typeof node.props.onOpenChange === "function",
    )
    return {
      click,
      copyButton,
      createObjectURL,
      dialog,
      downloadButton,
      renderer,
      revokeObjectURL,
      write,
    }
  }

  afterEach(() => {
    vi.mocked(toBlob).mockReset()
    vi.mocked(toast.success).mockReset()
    vi.mocked(toast.error).mockReset()
    vi.unstubAllGlobals()
  })

  it("confirms a completed image download", async () => {
    const blob = new Blob(["png"], { type: "image/png" })
    const click = vi.fn()
    const createObjectURL = vi.fn(() => "blob:share-card")
    const revokeObjectURL = vi.fn()
    vi.mocked(toBlob).mockResolvedValue(blob)
    vi.stubGlobal("document", {
      documentElement: {},
      fonts: { ready: Promise.resolve() },
      createElement: vi.fn(() => ({ click })),
    })
    vi.stubGlobal("getComputedStyle", vi.fn(() => ({
      getPropertyValue: vi.fn(() => ""),
    })))
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })
    const renderer = renderMessage(message(), {
      createNodeMock: () => ({ querySelectorAll: () => [] }),
    })
    const downloadButton = renderer.root.findAllByType("button").find(
      (button) => button.children.includes("Download"),
    )

    expect(downloadButton).toBeDefined()
    await act(async () => {
      await downloadButton!.props.onClick()
    })

    expect(click).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:share-card")
    expect(toast.success).toHaveBeenCalledWith("Image downloaded")
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("does not confirm a failed image download", async () => {
    const renderer = renderMessage(message())
    const downloadButton = renderer.root.findAllByType("button").find(
      (button) => button.children.includes("Download"),
    )

    expect(downloadButton).toBeDefined()
    await act(async () => {
      await downloadButton!.props.onClick()
    })

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't generate image — rendering the image failed",
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("shows a stage-specific render failure instead of clipboard advice", async () => {
    const renderer = renderMessage(message())
    const copyButton = renderer.root.findByProps({ "data-testid": tid.messageShareCopy })

    await act(async () => {
      await copyButton.props.onClick()
    })

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't generate image — rendering the image failed",
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("keeps Copy as the first winner when Download is clicked during its render", async () => {
    const rendering = deferred<Blob | null>()
    const blob = new Blob(["png"], { type: "image/png" })
    vi.mocked(toBlob).mockReturnValue(rendering.promise)
    const harness = setupActionEnvironment()
    let copy!: Promise<void>
    let download!: Promise<void>

    act(() => {
      copy = harness.copyButton.props.onClick()
      download = harness.downloadButton.props.onClick()
    })

    expect(download).toBe(copy)
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledOnce())
    await act(async () => {
      rendering.resolve(blob)
      await copy
    })

    expect(harness.write).toHaveBeenCalledOnce()
    expect(harness.click).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledWith("Image copied to clipboard")
    act(() => harness.renderer.unmount())
  })

  it("keeps Download as the first winner when Copy is clicked during its render", async () => {
    const rendering = deferred<Blob | null>()
    const blob = new Blob(["png"], { type: "image/png" })
    vi.mocked(toBlob).mockReturnValue(rendering.promise)
    const harness = setupActionEnvironment()
    let download!: Promise<void>
    let copy!: Promise<void>

    act(() => {
      download = harness.downloadButton.props.onClick()
      copy = harness.copyButton.props.onClick()
    })

    expect(copy).toBe(download)
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledOnce())
    await act(async () => {
      rendering.resolve(blob)
      await download
    })

    expect(harness.click).toHaveBeenCalledOnce()
    expect(harness.write).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledWith("Image downloaded")
  })

  it("releases a failed flight so the action can be retried", async () => {
    const blob = new Blob(["png"], { type: "image/png" })
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined)
    vi.mocked(toBlob).mockResolvedValue(blob)
    const harness = setupActionEnvironment(write)

    await act(async () => {
      await harness.copyButton.props.onClick()
    })
    await act(async () => {
      await harness.copyButton.props.onClick()
    })

    expect(toBlob).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy image — try Download instead")
    expect(toast.success).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledWith("Image copied to clipboard")
    act(() => harness.renderer.unmount())
  })

  it("never invokes a pending writer after the dialog closes", async () => {
    const rendering = deferred<Blob | null>()
    vi.mocked(toBlob).mockReturnValue(rendering.promise)
    const harness = setupActionEnvironment()
    let copy!: Promise<void>

    act(() => {
      copy = harness.copyButton.props.onClick()
    })
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledOnce())
    act(() => harness.dialog.props.onOpenChange(false))
    await act(async () => {
      await copy
      rendering.resolve(new Blob(["png"], { type: "image/png" }))
      await Promise.resolve()
    })

    expect(harness.write).not.toHaveBeenCalled()
    expect(harness.click).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(harness.copyButton.props.disabled).toBe(false)
  })

  it("never invokes a pending writer after the dialog unmounts", async () => {
    const rendering = deferred<Blob | null>()
    vi.mocked(toBlob).mockReturnValue(rendering.promise)
    const harness = setupActionEnvironment()
    let copy!: Promise<void>

    act(() => {
      copy = harness.copyButton.props.onClick()
    })
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledOnce())
    act(() => harness.renderer.unmount())
    await act(async () => {
      await copy
      rendering.resolve(new Blob(["png"], { type: "image/png" }))
      await Promise.resolve()
    })

    expect(harness.write).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("suppresses late feedback when the dialog closes after Clipboard API invocation", async () => {
    const writing = deferred<void>()
    const write = vi.fn(() => writing.promise)
    vi.mocked(toBlob).mockResolvedValue(new Blob(["png"], { type: "image/png" }))
    const harness = setupActionEnvironment(write)
    let copy!: Promise<void>

    act(() => {
      copy = harness.copyButton.props.onClick()
    })
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    act(() => harness.dialog.props.onOpenChange(false))
    await act(async () => {
      writing.resolve()
      await copy
    })

    expect(write).toHaveBeenCalledOnce()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(harness.copyButton.props.disabled).toBe(false)
    expect(harness.copyButton.children).toContain("Copy image")
  })
})
