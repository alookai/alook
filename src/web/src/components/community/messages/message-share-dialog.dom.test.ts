import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, render } from "@/test/react-dom-harness"
import { toBlob } from "html-to-image"
import { toast } from "sonner"
import {
  MessageShareDialog,
  ShareCardRenderError,
  copyRenderedShareCard,
  downloadRenderedShareCard,
  shareCardRenderErrorMessage,
  writeShareCardToClipboard,
} from "./message-share-dialog"
import type { RenderMsg } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { formatMessageTime } from "@/lib/community/format-time"

const profileState = vi.hoisted(() => ({ map: new Map<string, Record<string, unknown>>() }))
const componentMocks = vi.hoisted(() => ({
  avatarProps: vi.fn(),
  bodyProps: vi.fn(),
  dialogProps: vi.fn(),
}))
const sessionMocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  capture: vi.fn(),
}))

vi.mock("@/stores/community/ws", () => ({
  useProfilesByUserId: () => profileState.map,
}))
vi.mock("@/lib/community/share-image-session", () => {
  class ShareImageSessionError extends Error {
    constructor(
      readonly stage: "source" | "assets" | "fonts" | "freeze" | "rasterize",
      readonly timedOut = false,
      cause?: unknown,
    ) {
      super(`Share image failed during ${stage}`)
      this.name = "ShareImageSessionError"
      this.cause = cause
    }
  }
  return {
    ShareImageSessionError,
    prepareShareImageSession: sessionMocks.prepare,
    capturePreparedShareImage: sessionMocks.capture,
  }
})
vi.mock("html-to-image", () => ({ toBlob: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/components/community/shell/animated-alook-logo", () => ({
  AnimatedAlookLogo: (props: React.ComponentProps<"svg">) => React.createElement(
    "svg",
    { ...props, "data-inline-alook-logo": "", viewBox: "0 0 16 16" },
    React.createElement("path", { d: "M0 0h16v16H0z" }),
  ),
}))
vi.mock("../avatar", () => ({
  Avatar: (props: Record<string, unknown>) => {
    componentMocks.avatarProps(props)
    return props.src
      ? React.createElement("img", { src: props.src, "data-avatar-photo-state": "ready" })
      : React.createElement("span", { "data-avatar-kind": "beam" })
  },
}))
vi.mock("./message-body", () => ({
  MessageBody: (props: { text: string }) => {
    componentMocks.bodyProps(props)
    return React.createElement("div", { "data-mock-message-body": "" }, props.text)
  },
}))
vi.mock("@/components/ui/button", () => ({
  Button: ({ variant: _variant, size: _size, ...props }: React.ComponentProps<"button"> & {
    variant?: string
    size?: string
  }) => React.createElement("button", props),
}))
vi.mock("@/components/ui/dialog", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => children
  return {
    Dialog: ({ children, ...props }: { children?: React.ReactNode }) => {
      componentMocks.dialogProps(props)
      return children
    },
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

function preparedFrom(source: HTMLElement) {
  const card = source.cloneNode(true) as HTMLElement
  card.removeAttribute("data-share-card-source")
  card.setAttribute("data-share-card", "")
  card.dataset.shareSessionState = "ready"
  return Object.freeze({
    markup: card.outerHTML,
    width: 672,
    height: 240,
    backgroundColor: "rgb(255, 255, 255)",
    fontEmbedCSS: "@font-face{font-family:brand;src:url(data:font/woff2;base64,AA==)}",
  })
}

function renderMessage(m: RenderMsg | RenderMsg[] = message()) {
  const values = Array.isArray(m) ? m : [m]
  profileState.map = new Map()
  for (const value of values) {
    if (!value.authorId) continue
    profileState.map.set(value.authorId, {
      id: value.authorId,
      name: value.authorName,
      ...(value.authorAvatar ? { avatar: value.authorAvatar } : {}),
      avatarVersion: value.authorAvatarVersion ?? 0,
    })
  }
  return render(React.createElement(MessageShareDialog, { m, open: true, onClose: vi.fn() }))
}

async function renderReady(m: RenderMsg | RenderMsg[] = message()) {
  const renderer = renderMessage(m)
  await vi.waitFor(() => {
    expect(renderer.container.querySelector('[data-share-session-state="ready"]')).not.toBeNull()
  })
  return renderer
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(text))
  if (!button) throw new Error(`Missing ${text} button`)
  return button
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

class ClipboardItemStub {
  constructor(readonly items: Record<string, Blob>) {}
}

function installWebClipboard(write = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("ClipboardItem", ClipboardItemStub)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write },
  })
  return write
}

function installMobileNative(invoke: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: { core: { invoke } },
  })
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionMocks.prepare.mockImplementation(async (source: HTMLElement) => preparedFrom(source))
  sessionMocks.capture.mockImplementation(async (
    source: HTMLElement,
    fontEmbedCSS: string,
    rasterize: typeof toBlob,
    options: { signal?: AbortSignal },
  ) => {
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError")
    const blob = await rasterize(source, { fontEmbedCSS })
    if (!blob) throw new ShareCardRenderError("rasterize")
    return blob
  })
  vi.mocked(toBlob).mockResolvedValue(new Blob(["png"], { type: "image/png" }))
})

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI__")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("MessageShareDialog session lifecycle", () => {
  it("keeps export actions disabled until the immutable preview is ready", async () => {
    const preparation = deferred<ReturnType<typeof preparedFrom>>()
    sessionMocks.prepare.mockReturnValueOnce(preparation.promise)
    const renderer = renderMessage()

    await vi.waitFor(() => expect(sessionMocks.prepare).toHaveBeenCalledTimes(1))
    expect(renderer.container.querySelector("[data-share-card-source]")).not.toBeNull()
    expect(renderer.container.querySelector("[data-share-card]")).toBeNull()
    expect(buttonWithText(renderer.container, "Download").disabled).toBe(true)
    expect(buttonWithText(renderer.container, "Copy image").disabled).toBe(true)

    await act(async () => preparation.resolve(preparedFrom(
      sessionMocks.prepare.mock.calls[0]![0] as HTMLElement,
    )))

    expect(renderer.container.querySelector("[data-share-card-source]")).toBeNull()
    expect(renderer.container.querySelector("[data-share-card]")).not.toBeNull()
    expect(buttonWithText(renderer.container, "Download").disabled).toBe(false)
    expect(buttonWithText(renderer.container, "Copy image").disabled).toBe(false)
  })

  it("renders message context and an inline brand SVG in the prepared preview", async () => {
    const createdAt = "2026-08-13T03:17:00.000Z"
    const renderer = await renderReady(message({
      createdAt,
      authorAvatar: "https://avatars.githubusercontent.com/u/1?v=4",
      content: "@Bob\n**visible** body",
      replyTo: { id: "original", authorName: "Bob", text: "Original **body**" },
      attachments: [
        { kind: "image", name: "photo.png", url: "/photo.png", width: 800, height: 400 },
        { kind: "file", name: "notes.txt", url: "/notes.txt" },
      ],
      reactions: [{ emoji: "👍", count: 2, me: true, userIds: ["u1"] }],
    }))
    const preview = renderer.container.querySelector('[data-share-session-state="ready"]')!

    expect(preview.querySelector("[data-share-timestamp]")?.textContent).toBe(formatMessageTime(createdAt))
    expect(preview.querySelector('[data-testid="message-share-reply-m1"]')?.textContent)
      .toContain("Original body")
    expect(preview.querySelector("[data-mock-message-body]")?.textContent).toBe("**visible** body")
    expect(preview.querySelector('[data-testid="message-share-image-m1-0"]')).not.toBeNull()
    expect(preview.textContent).not.toContain("notes.txt")
    expect(preview.querySelector("[data-share-identity-id=u1]")).not.toBeNull()
    expect(preview.querySelector("svg[data-inline-alook-logo]")).not.toBeNull()
    expect(preview.querySelector('img[src="/alook.svg"]')).toBeNull()
  })

  it("keeps the ready preview frozen across profile-store rerenders", async () => {
    const shared = message({ authorAvatar: "/api/community/users/u1/avatar?v=1" })
    const renderer = await renderReady(shared)
    const card = renderer.container.querySelector("[data-share-card]")!
    const markup = card.outerHTML
    profileState.map = new Map([["u1", {
      id: "u1",
      name: "Changed live profile",
      avatar: "/api/community/users/u1/avatar?v=2",
      avatarVersion: 2,
    }]])

    renderer.rerender(React.createElement(MessageShareDialog, {
      m: shared,
      open: true,
      onClose: vi.fn(),
    }))
    await act(async () => Promise.resolve())

    expect(sessionMocks.prepare).toHaveBeenCalledTimes(1)
    expect(renderer.container.querySelector("[data-share-card]")?.outerHTML).toBe(markup)
  })

  it("shows a typed preparation error and retries from the source tree", async () => {
    sessionMocks.prepare
      .mockRejectedValueOnce(new ShareCardRenderError("assets", true))
      .mockImplementationOnce(async (source: HTMLElement) => preparedFrom(source))
    const renderer = renderMessage()

    await vi.waitFor(() => expect(renderer.container.textContent).toContain("preparing images took too long"))
    expect(buttonWithText(renderer.container, "Copy image").disabled).toBe(true)

    await act(async () => buttonWithText(renderer.container, "Retry").click())
    await vi.waitFor(() => expect(renderer.container.querySelector("[data-share-card]")).not.toBeNull())
    expect(sessionMocks.prepare).toHaveBeenCalledTimes(2)
  })

  it("applies highlights only to the immutable preview and invalidates its PNG", async () => {
    const renderer = await renderReady(message({ content: "highlight this text" }))
    const body = renderer.container.querySelector<HTMLElement>("[data-share-body-id=m1]")!
    const text = body.querySelector("[data-mock-message-body]")!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 9)
    selection.removeAllRanges()
    selection.addRange(range)

    await act(async () => body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })))

    expect(body.querySelector("mark[data-hl]")?.textContent).toBe("highlight")
    expect(buttonWithText(renderer.container, "Reset highlight")).not.toBeNull()
  })
})

describe("MessageShareDialog message projection", () => {
  it("renders the live message timestamp beside the author", async () => {
    const createdAt = "2026-08-13T03:17:00.000Z"
    const renderer = await renderReady(message({ createdAt }))
    const timestamp = renderer.container.querySelector("[data-share-timestamp]")!

    expect(timestamp.textContent).toBe(formatMessageTime(createdAt))
    expect(timestamp.classList).toContain("text-xs")
    expect(timestamp.classList).toContain("text-muted-foreground")
    expect(timestamp.parentElement?.classList).toContain("items-baseline")
    expect(timestamp.parentElement?.classList).toContain("gap-2")
  })

  it("keeps the author and timestamp collapsed for grouped follow-ups", async () => {
    const renderer = await renderReady(message({
      grouped: true,
      createdAt: "2026-08-13T03:18:00.000Z",
    }))

    expect(renderer.container.querySelector("[data-share-timestamp]")).toBeNull()
  })

  it("passes the custom avatar URL as an image source, not as fallback copy", async () => {
    await renderReady(message({ authorAvatar: "/api/community/users/u1/avatar" }))

    expect(componentMocks.avatarProps).toHaveBeenCalledWith(expect.objectContaining({
      label: "Alice",
      src: "/api/community/users/u1/avatar",
      seed: "u1",
    }))
  })

  it("renders the reply author and plain-text excerpt above the shared message", async () => {
    const renderer = await renderReady(message({
      replyTo: {
        id: "original",
        authorName: "Bob",
        text: "A **formatted** reply",
      },
    }))

    const reply = renderer.container.querySelector('[data-testid="message-share-reply-m1"]')!
    expect([...reply.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
      "@Bob",
      "A formatted reply",
    ])
  })

  it("keeps the reply header while sharing only projected message content", async () => {
    const renderer = await renderReady(message({
      content: "@Bob Smith\n**visible** body",
      replyTo: {
        id: "original",
        authorName: "Bob Smith",
        text: "Original body",
      },
    }))

    expect(componentMocks.bodyProps).toHaveBeenCalledWith(expect.objectContaining({
      text: "**visible** body",
    }))
    const reply = renderer.container.querySelector('[data-testid="message-share-reply-m1"]')!
    expect([...reply.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
      "@Bob Smith",
      "Original body",
    ])
  })

  it("omits a standalone body for an attachment-only canonical reply", async () => {
    const renderer = await renderReady(message({
      content: "@Bob\n",
      replyTo: { id: "original", authorName: "Bob", text: "Original body" },
      attachments: [{ kind: "image", name: "photo.png", url: "/photo.png" }],
    }))

    expect(renderer.container.querySelectorAll("[data-mock-message-body]")).toHaveLength(0)
    expect(renderer.container.querySelector(`[data-testid="${tid.messageShareImage("m1", 0)}"]`))
      .not.toBeNull()
  })

  it("renders the deleted-original state without stale reply details", async () => {
    const renderer = await renderReady(message({
      replyTo: {
        id: "original",
        authorName: "Bob",
        text: "Stale content",
        deleted: true,
      },
    }))

    const reply = renderer.container.querySelector('[data-testid="message-share-reply-m1"]')!
    expect([...reply.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
      "Original message was deleted",
    ])
  })

  it("renders every emoji reaction with its count", async () => {
    const renderer = await renderReady(message({
      reactions: [
        { emoji: "👍", count: 2, me: true, userIds: ["u1", "u2"] },
        { emoji: "🎉", count: 11, me: false, userIds: [] },
      ],
    }))

    const reactions = renderer.container.querySelector('[data-testid="message-share-reactions-m1"]')!
    expect([...reactions.querySelectorAll("span")].map((span) => span.textContent)).toEqual(
      expect.arrayContaining(["👍", "2", "🎉", "11"]),
    )
  })

  it("renders attached originals at intrinsic ratio and omits files", async () => {
    const renderer = await renderReady(message({
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

    const image = renderer.container.querySelector<HTMLImageElement>(
      `[data-testid="${tid.messageShareImage("m1", 0)}"]`,
    )!
    expect(image.getAttribute("src")).toBe("/original-photo.png")
    expect(image.alt).toBe("photo.png")
    expect(image.width).toBe(1200)
    expect(image.height).toBe(800)
    expect(image.getAttribute("loading")).toBe("eager")
    expect(image.style.aspectRatio).toBe("1200/800")
    expect(image.className).toContain("max-h-75")
    expect(image.className).toContain("max-w-full")
    expect(image.className).toContain("object-contain")
    expect(image.parentElement?.className).toContain("w-fit")
    expect(image.parentElement?.className).toContain("border")
    expect(renderer.container.querySelectorAll('[src="/notes.txt"]')).toHaveLength(0)
  })

  it("keeps image previews above reactions like the live message", async () => {
    const renderer = await renderReady(message({
      content: "",
      attachments: [{ kind: "image", name: "photo.png", url: "/photo.png" }],
      reactions: [{ emoji: "👍", count: 2, me: false, userIds: [] }],
    }))

    const contextOrder = [...renderer.container.querySelectorAll(
      '[data-testid="message-share-images-m1"], [data-testid="message-share-reactions-m1"]',
    )].map((node) => node.getAttribute("data-testid"))
    expect(contextOrder).toEqual(["message-share-images-m1", "message-share-reactions-m1"])
  })

  it("does not add empty context containers", async () => {
    const renderer = await renderReady(message())
    const card = renderer.container.querySelector("[data-share-card]")!

    expect(card.querySelectorAll('[data-testid^="message-share-"]')).toHaveLength(0)
  })
})

describe("MessageShareDialog exports", () => {
  it("reuses one finalized PNG for consecutive Copy then Download", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const createObjectURL = vi.fn(() => "blob:share-card")
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    })
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    })
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Image copied to clipboard"))
    await act(async () => buttonWithText(renderer.container, "Download").click())
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Image downloaded"))

    expect(sessionMocks.capture).toHaveBeenCalledTimes(1)
    expect(toBlob).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:share-card"))
  })

  it("reports rasterization failure without invoking clipboard", async () => {
    const write = vi.fn()
    vi.stubGlobal("ClipboardItem", class ClipboardItem {})
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    })
    sessionMocks.capture.mockRejectedValueOnce(new ShareCardRenderError("rasterize", true))
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Couldn't generate image — rendering the image took too long",
    ))
    expect(write).not.toHaveBeenCalled()
    expect(buttonWithText(renderer.container, "Copy image").disabled).toBe(false)
  })

  it("aborts an active export and suppresses its late receipt after close", async () => {
    const rendered = deferred<Blob>()
    sessionMocks.capture.mockReturnValueOnce(rendered.promise)
    const write = vi.fn()
    vi.stubGlobal("ClipboardItem", class ClipboardItem {})
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    })
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    const dialogProps = componentMocks.dialogProps.mock.calls.at(-1)?.[0] as {
      onOpenChange: (open: boolean) => void
    }
    await act(async () => dialogProps.onOpenChange(false))
    await act(async () => rendered.resolve(new Blob(["late"], { type: "image/png" })))

    expect(write).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("shows mobile copy success only after the terminal native receipt", async () => {
    const native = deferred<Record<string, unknown>>()
    const invoke = vi.fn(() => native.promise)
    installMobileNative(invoke)
    const renderer = await renderReady()
    const copy = buttonWithText(renderer.container, "Copy image")
    const save = buttonWithText(renderer.container, "Save image")

    await act(async () => copy.click())
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0]![0]).toBe("mobile_share_image_copy")
    expect(copy.disabled).toBe(true)
    expect(save.disabled).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
    const attemptId = invoke.mock.calls[0]![1].payload.attemptId as string

    await act(async () => native.resolve({
      attemptId,
      status: "copied",
      destination: "clipboard",
    }))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Image copied to clipboard"))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    ["photos", "Saved to Photos"],
    ["pictures", "Saved to Pictures/Alook"],
    ["document", "Image saved"],
  ] as const)("maps the mobile %s receipt to exact save feedback", async (destination, feedback) => {
    const invoke = vi.fn(async (_command: string, args: {
      payload: { attemptId: string; filename: string }
    }) => ({
      attemptId: args.payload.attemptId,
      status: "saved",
      destination,
    }))
    installMobileNative(invoke)
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Save image").click())

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]![0]).toBe("mobile_share_image_save")
    expect(invoke.mock.calls[0]![1].payload.filename).toBe("alook-message-Alice.png")
    expect(toast.success).toHaveBeenCalledWith(feedback)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("keeps mobile cancellation silent and re-enables both actions", async () => {
    const invoke = vi.fn().mockRejectedValue({ code: "cancelled", message: "cancelled" })
    installMobileNative(invoke)
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Save image").click())

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(buttonWithText(renderer.container, "Copy image").disabled).toBe(false)
    expect(buttonWithText(renderer.container, "Save image").disabled).toBe(false)
  })

  it("shows mobile permission and oversize failures without success", async () => {
    const denied = vi.fn().mockRejectedValue({ code: "permission_denied", message: "denied" })
    installMobileNative(denied)
    let renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Save image").click())
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save image — allow Photos access in Settings",
    )
    expect(toast.success).not.toHaveBeenCalled()

    renderer.unmount()
    vi.mocked(toast.error).mockReset()
    const invoke = vi.fn()
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: { core: { invoke } },
    })
    sessionMocks.capture.mockResolvedValueOnce({
      type: "image/png",
      size: 10 * 1024 * 1024 + 1,
    } as Blob)
    renderer = await renderReady()
    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    expect(toast.error).toHaveBeenCalledWith("Image is too large — select fewer messages")
    expect(toast.success).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("keeps the first mobile action as sole owner during overlap", async () => {
    const native = deferred<Record<string, unknown>>()
    const invoke = vi.fn(() => native.promise)
    installMobileNative(invoke)
    const renderer = await renderReady()
    const copy = buttonWithText(renderer.container, "Copy image")
    const save = buttonWithText(renderer.container, "Save image")

    act(() => {
      copy.click()
      save.click()
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke.mock.calls[0]![0]).toBe("mobile_share_image_copy")
    const attemptId = invoke.mock.calls[0]![1].payload.attemptId as string
    await act(async () => native.resolve({
      attemptId,
      status: "copied",
      destination: "clipboard",
    }))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
  })

  it("suppresses late mobile feedback after close", async () => {
    const native = deferred<Record<string, unknown>>()
    const invoke = vi.fn(() => native.promise)
    installMobileNative(invoke)
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Save image").click())
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const dialogProps = componentMocks.dialogProps.mock.calls.at(-1)?.[0] as {
      onOpenChange: (open: boolean) => void
    }
    act(() => dialogProps.onOpenChange(false))
    const attemptId = invoke.mock.calls[0]![1].payload.attemptId as string
    await act(async () => native.resolve({
      attemptId,
      status: "saved",
      destination: "photos",
    }))
    await act(async () => Promise.resolve())

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    ["Copy", "Download", "Image copied to clipboard"],
    ["Download", "Copy image", "Image downloaded"],
  ] as const)("keeps %s as first winner when %s overlaps", async (first, second, feedback) => {
    const rendered = deferred<Blob>()
    sessionMocks.capture.mockReturnValueOnce(rendered.promise)
    const write = installWebClipboard()
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:share-card"),
      revokeObjectURL: vi.fn(),
    }))
    const renderer = await renderReady()
    const firstButton = buttonWithText(renderer.container, first === "Copy" ? "Copy image" : first)
    const secondButton = buttonWithText(renderer.container, second)

    act(() => {
      firstButton.click()
      secondButton.click()
    })
    await act(async () => rendered.resolve(new Blob(["png"], { type: "image/png" })))
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith(feedback))

    if (first === "Copy") {
      expect(write).toHaveBeenCalledTimes(1)
      expect(click).not.toHaveBeenCalled()
    } else {
      expect(click).toHaveBeenCalledTimes(1)
      expect(write).not.toHaveBeenCalled()
    }
  })

  it("releases a failed action so Copy can retry the finalized PNG", async () => {
    const write = installWebClipboard(vi.fn()
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined))
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Couldn't copy image — try Download instead",
    ))
    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith("Image copied to clipboard"))

    expect(sessionMocks.capture).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it("suppresses a late raster result after unmount", async () => {
    const rendered = deferred<Blob>()
    sessionMocks.capture.mockReturnValueOnce(rendered.promise)
    const write = installWebClipboard()
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    renderer.unmount()
    await act(async () => rendered.resolve(new Blob(["late"], { type: "image/png" })))

    expect(write).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("suppresses late feedback after close once Clipboard API is in flight", async () => {
    const write = deferred<void>()
    installWebClipboard(vi.fn(() => write.promise))
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Copy image").click())
    await vi.waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledTimes(1))
    const dialogProps = componentMocks.dialogProps.mock.calls.at(-1)?.[0] as {
      onOpenChange: (open: boolean) => void
    }
    act(() => dialogProps.onOpenChange(false))
    await act(async () => write.resolve())
    await act(async () => Promise.resolve())

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("does not confirm a failed image download", async () => {
    sessionMocks.capture.mockRejectedValueOnce(new ShareCardRenderError("rasterize"))
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    const renderer = await renderReady()

    await act(async () => buttonWithText(renderer.container, "Download").click())
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Couldn't generate image — rendering the image failed",
    ))

    expect(click).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe("share image action helpers", () => {
  it("hands only a completed PNG to copy and download writers", async () => {
    const blob = new Blob(["png"], { type: "image/png" })
    const copyWrite = vi.fn()
    const downloadWrite = vi.fn()

    await copyRenderedShareCard(async () => blob, copyWrite)
    await downloadRenderedShareCard(async () => blob, "share.png", downloadWrite)

    expect(copyWrite).toHaveBeenCalledWith(blob)
    expect(downloadWrite).toHaveBeenCalledWith(blob)
  })

  it("rejects an empty raster result before either writer", async () => {
    const write = vi.fn()

    await expect(copyRenderedShareCard(async () => null, write)).rejects.toMatchObject({
      stage: "rasterize",
    })
    await expect(downloadRenderedShareCard(async () => null, "share.png", write)).rejects.toMatchObject({
      stage: "rasterize",
    })
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    ["source", "preparing the preview"],
    ["assets", "preparing images"],
    ["fonts", "loading fonts"],
    ["freeze", "freezing the preview"],
    ["rasterize", "rendering the image"],
  ] as const)("maps %s failures to stage-specific feedback", (stage, copy) => {
    expect(shareCardRenderErrorMessage(new ShareCardRenderError(stage))).toBe(
      `Couldn't generate image — ${copy} failed`,
    )
    expect(shareCardRenderErrorMessage(new ShareCardRenderError(stage, true))).toBe(
      `Couldn't generate image — ${copy} took too long`,
    )
  })

  it("writes web PNG bytes through one Clipboard API call", async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("ClipboardItem", class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    })
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write },
    })
    const blob = new Blob(["png"], { type: "image/png" })

    await writeShareCardToClipboard(blob)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toHaveLength(1)
    expect(write.mock.calls[0]![0]![0].items).toEqual({ "image/png": blob })
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

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0]![0]).toBe("plugin:clipboard-manager|write_image")
    expect([...new Uint8Array(invoke.mock.calls[0]![1].image)]).toEqual([...bytes])
    expect(webWrite).not.toHaveBeenCalled()
  })

  it("does not retry Web Clipboard after a native desktop rejection", async () => {
    const failure = new Error("native clipboard rejected")
    const invoke = vi.fn().mockRejectedValue(failure)
    const webWrite = vi.fn()
    vi.stubGlobal("window", {
      __TAURI__: {},
      __TAURI_INTERNALS__: { invoke },
    })
    vi.stubGlobal("navigator", { userAgent: "Macintosh", clipboard: { write: webWrite } })

    await expect(writeShareCardToClipboard(new Blob(["png"]))).rejects.toBe(failure)

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(webWrite).not.toHaveBeenCalled()
  })

  it("does not retry Web Clipboard when the native invoke bridge is missing", async () => {
    const webWrite = vi.fn()
    vi.stubGlobal("window", { __TAURI__: {} })
    vi.stubGlobal("navigator", { userAgent: "Macintosh", clipboard: { write: webWrite } })
    vi.stubGlobal("ClipboardItem", ClipboardItemStub)

    await expect(writeShareCardToClipboard(new Blob(["png"]))).rejects.toThrow()

    expect(webWrite).not.toHaveBeenCalled()
  })
})
