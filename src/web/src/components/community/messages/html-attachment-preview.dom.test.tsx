import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { ApplicationOwnerProvider, createApplicationOwner, retireApplicationOwner } from "@/lib/application-owner"
import { Message } from "./message"
import { ThreadOpener } from "./thread-opener"
import { HtmlAttachmentPreview } from "./html-attachment-preview"
import { MessageBodyView } from "./message-body-view"
import { tid } from "@/lib/community/testids"
import { fileDownloadKey } from "@/lib/file-download"
import { readHtmlPreviewMemoryHeight } from "@/lib/community/html-preview-height-cache"
import { buildHtmlPreviewScrollFadeMask } from "@/hooks/community/use-html-preview-viewport"
import { NATIVE_MOBILE_BACK_EVENT, useNativeMobileBack } from "@/hooks/community/use-native-mobile-back"

const opener = vi.hoisted(() => ({ message: {} }))
vi.mock("@/hooks/community/use-message", () => ({ useMessage: () => ({ message: opener.message, isLoading: false, isError: false }) }))
const theme = vi.hoisted(() => ({ resolvedTheme: "light" }))
vi.mock("next-themes", () => ({ useTheme: () => theme }))
const file = { id: "a1", name: "demo.html", contentType: "text/html", kind: "file" as const, url: "/api/community/channels/c1/attachments/a1", size: "100 B" }
const owners: ReturnType<typeof createApplicationOwner>[] = []
function setup(body = <HtmlAttachmentPreview attachment={file} />) {
  const owner = createApplicationOwner("viewer")
  owners.push(owner)
  const tree = (node = body) => <ApplicationOwnerProvider owner={owner}>{node}</ApplicationOwnerProvider>
  const view = render(tree())
  return { ...view, owner, tree }
}
function frameMessage(frame: HTMLIFrameElement, data: unknown, over: MessageEventInit = {}) {
  fireEvent(window, new MessageEvent("message", { data, source: frame.contentWindow, origin: "null", ...over }))
}
function BackListener({ replacePath }: { replacePath: (path: string) => void }) {
  useNativeMobileBack({ dismissShellOverlay: () => false, parentPath: "/c/me", replacePath })
  return null
}
afterEach(() => { for (const owner of owners.splice(0)) owner.queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); theme.resolvedTheme = "light"; vi.useRealTimers() })

describe("HTML attachment frame", () => {
  it("keeps the filename out of content without host actions or hidden download controls", () => {
    const view = setup()
    expect(view.queryByText(file.name)).toBeNull()
    expect(view.queryByRole("group", { name: "HTML preview actions" })).toBeNull()
    expect(view.container.querySelectorAll("button, a[download], [data-html-preview-actions]")).toHaveLength(0)
    expect(view.queryByRole("dialog")).toBeNull()
    expect(view.getByTestId(tid.htmlPreview("a1"))).not.toHaveAttribute("aria-modal")
    expect(view.getByTestId(tid.htmlPreview("a1"))).toHaveAccessibleName(file.name)
  })
  it("keeps one opaque-origin frame and clamps valid current-frame measurements to half viewport height", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.3")
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 })
    try {
      const view = setup()
      const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
      expect(frame).toHaveAttribute("src", `${file.url}?preview=html&v=1.2.3`)
      expect(frame.getAttribute("sandbox")).toContain("allow-scripts")
      expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
      expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
      frameMessage(frame, { type: "alook-html-height", height: 123 }, { source: window })
      frameMessage(frame, { type: "alook-html-height", height: 123 }, { origin: "https://elsewhere.test" })
      for (const height of [NaN, Infinity, -2, "123"]) frameMessage(frame, { type: "alook-html-height", height })
      expect(frame.style.height).toBe("320px")
      frameMessage(frame, { type: "alook-html-height", height: 123.4 })
      expect(frame.style.height).toBe("124px")
      frameMessage(frame, { type: "alook-html-height", height: 999999 })
      expect(frame.style.height).toBe("450px")
      expect(readHtmlPreviewMemoryHeight(view.owner.queryClient, "a1")).toBe(2000)
      frameMessage(frame, { type: "alook-html-height", height: 1 })
      expect(frame.style.height).toBe("80px")
      frameMessage(frame, { type: "alook-html-ready" })
      expect(view.getByTestId(tid.htmlPreview("a1"))).toHaveAttribute("data-html-preview-status", "ready")
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight })
    }
  })
  it("changes only the preview URL with the existing application version", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.3")
    const view = setup()
    const frame = view.getByTestId(tid.htmlPreviewFrame("a1"))
    expect(frame).toHaveAttribute("src", `${file.url}?preview=html&v=1.2.3`)
    const download = view.owner.queryClient.getQueryCache().find({ queryKey: fileDownloadKey(view.owner, file), exact: true })
    expect(download).toBeUndefined()
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.2.4+build &next=2")
    view.rerender(view.tree(<HtmlAttachmentPreview attachment={file} />))
    expect(frame).toHaveAttribute("src", `${file.url}?preview=html&v=1.2.4%2Bbuild%20%26next%3D2`)
    expect(view.owner.queryClient.getQueryCache().find({ queryKey: fileDownloadKey(view.owner, file), exact: true })).toBeUndefined()
    expect(file.url).toBe("/api/community/channels/c1/attachments/a1")
  })
  it("posts updated Alook theme without replacing the document", () => {
    const view = setup(), frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, "postMessage")
    document.documentElement.style.setProperty("--background", "#fefdfb")
    frameMessage(frame, { type: "alook-html-ready" })
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "alook-html-theme", dark: false, variables: expect.objectContaining({ "--background": "#fefdfb" }) }), "*")
    theme.resolvedTheme = "dark"
    view.rerender(view.tree(<HtmlAttachmentPreview attachment={file} />))
    expect(view.getByTestId(tid.htmlPreviewFrame("a1"))).toBe(frame)
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ dark: true }), "*")
    document.documentElement.style.removeProperty("--background")
  })
  it("keeps an icon-only loading status until the current lazy frame reports ready", () => {
    let intersect: IntersectionObserverCallback | undefined
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { intersect = callback } observe() {} disconnect() {} })
    const view = setup()
    const preview = view.getByTestId(tid.htmlPreview("a1"))
    const loading = view.getByRole("status", { name: "Loading preview" })
    expect(preview.querySelectorAll("button, a[download], [data-html-preview-actions]")).toHaveLength(0)
    expect(loading.textContent).toBe("")
    expect(loading.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
    expect(preview.style.height).toBe("320px")
    expect(view.queryByTestId(tid.htmlPreviewFrame("a1"))).toBeNull()
    expect([...preview.children]).toEqual([loading])
    act(() => intersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
    expect(preview.style.height).toBe("")
    expect(frame.style.height).toBe("320px")
    fireEvent.load(frame)
    frameMessage(frame, { type: "alook-html-ready" }, { source: window })
    expect(view.getByRole("status", { name: "Loading preview" })).toBe(loading)
    frameMessage(frame, { type: "alook-html-ready" })
    expect(view.queryByRole("status", { name: "Loading preview" })).toBeNull()
    expect(view.getByTestId(tid.htmlPreviewFrame("a1"))).toBe(frame)
    expect(preview).toHaveAttribute("data-html-preview-status", "ready")
    expect(preview.querySelectorAll("button, a[download], [data-html-preview-actions]")).toHaveLength(0)
    expect([...preview.children]).toEqual([frame])
  })
  it("leaves native Back to the normal page route with an inline preview", () => {
    const originalUrl = window.location.href
    const replacePath = vi.fn((path: string) => window.history.replaceState(null, "", path))
    window.history.replaceState(null, "", "/c/channels/server/channel")
    try {
      const view = setup(<><BackListener replacePath={replacePath} /><textarea aria-label="Host draft" defaultValue="saved draft" /><HtmlAttachmentPreview attachment={file} /></>)
      const frame = view.getByTestId(tid.htmlPreviewFrame("a1"))
      const event = new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })
      act(() => { window.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(true)
      expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
      expect(view.getByTestId(tid.htmlPreviewFrame("a1"))).toBe(frame)
      expect(view.queryByRole("dialog")).toBeNull()
      expect(view.getByRole("textbox", { name: "Host draft" })).toHaveValue("saved draft")
    } finally { window.history.replaceState(null, "", originalUrl) }
  })
  it("waits until near the viewport and cleans up on owner retirement", () => {
    let intersect: IntersectionObserverCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { intersect = callback } observe() {} disconnect = disconnect })
    const view = setup()
    expect(view.queryByTestId(tid.htmlPreviewFrame("a1"))).toBeNull()
    act(() => intersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
    act(() => retireApplicationOwner(view.owner))
    expect(view.queryByTestId(tid.htmlPreview("a1"))).toBeNull()
    frameMessage(frame, { type: "alook-html-ready" })
    expect(view.queryByTestId(tid.htmlPreview("a1"))).toBeNull()
    expect(disconnect).toHaveBeenCalled()
  })
  it("rejects a late message from a replaced attachment frame", () => {
    const view = setup()
    const previous = (view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement).contentWindow
    view.rerender(view.tree(<HtmlAttachmentPreview attachment={{ ...file, id: "a2", url: "/api/community/channels/c1/attachments/a2" }} />))
    const current = view.getByTestId(tid.htmlPreviewFrame("a2")) as HTMLIFrameElement
    fireEvent(window, new MessageEvent("message", { origin: "null", source: previous, data: { type: "alook-html-ready" } }))
    fireEvent(window, new MessageEvent("message", { origin: "null", source: previous, data: { type: "alook-html-height", height: 999 } }))
    expect(current.style.height).toBe("320px")
    expect(view.getByTestId(tid.htmlPreview("a2"))).toHaveAttribute("data-html-preview-status", "loading")
    frameMessage(current, { type: "alook-html-ready" })
    expect(view.getByTestId(tid.htmlPreview("a2"))).toHaveAttribute("data-html-preview-status", "ready")
  })
  it("hides a preview that never becomes ready, keeping surrounding text", () => {
    vi.useFakeTimers()
    const view = setup(<MessageBodyView plugins={{}} text={"before\n\n[alook-html-preview](a1)\n\nafter"} attachments={[file]} />)
    act(() => vi.advanceTimersByTime(15_000))
    expect(view.queryByTestId(tid.htmlPreviewFrame("a1"))).toBeNull()
    expect(view.queryByTestId(tid.htmlPreview("a1"))).toBeNull()
    expect(view.queryByRole("status")).toBeNull()
    expect(view.container).not.toHaveTextContent("Preview unavailable")
    expect(view.container).toHaveTextContent("before")
    expect(view.container).toHaveTextContent("after")
  })
  it("synchronously restores cached naturalHeight on remount and dynamically re-clamps on viewport resize", () => {
    const originalInnerHeight = window.innerHeight
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 })
    try {
      const view = setup()
      const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
      expect(frame.style.height).toBe("320px")
      frameMessage(frame, { type: "alook-html-height", height: 642 })
      expect(frame.style.height).toBe("400px")
      expect(readHtmlPreviewMemoryHeight(view.owner.queryClient, "a1")).toBe(642)

      Object.defineProperty(window, "innerHeight", { configurable: true, value: 1600 })
      fireEvent(window, new Event("resize"))
      expect(frame.style.height).toBe("642px")

      view.rerender(view.tree(<div />))
      view.rerender(view.tree(<HtmlAttachmentPreview attachment={file} />))
      const remounted = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
      expect(remounted.style.height).toBe("642px")
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight })
    }
  })

  it("caps preview height from the nearest scroll-area viewport, applies dynamic scroll-fade, and drives scroll-to from the outer overlay scrollbar", () => {
    vi.useFakeTimers()
    const view = setup(
      <div data-slot="scroll-area-viewport" data-testid="inbox-viewport">
        <HtmlAttachmentPreview attachment={file} />
      </div>,
    )
    const viewport = view.getByTestId("inbox-viewport")
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 600 })
    fireEvent(window, new Event("resize"))

    const preview = view.getByTestId(tid.htmlPreview("a1"))
    const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, "postMessage")

    frameMessage(frame, { type: "alook-html-height", height: 220 })
    frameMessage(frame, { type: "alook-html-ready" })
    expect(frame.style.height).toBe("220px")
    expect(frame).toHaveAttribute("data-scroll-fade", "none")
    expect(preview.querySelector('[data-slot="html-preview-scrollbar"]')).toBeNull()

    frameMessage(frame, { type: "alook-html-height", height: 2000 })
    frameMessage(frame, { type: "alook-html-scroll", scrollTop: 0, scrollHeight: 2400, clientHeight: 300 })
    expect(frame.style.height).toBe("300px")
    expect(frame).toHaveAttribute("data-scroll-fade", "bottom")
    expect(buildHtmlPreviewScrollFadeMask("bottom")).toContain("calc(100% - 36px)")
    expect(buildHtmlPreviewScrollFadeMask("bottom")).not.toContain("transparent 0px, black 28px")

    const scrollbar = preview.querySelector<HTMLElement>('[data-slot="html-preview-scrollbar"]')!
    expect(scrollbar).not.toBeNull()
    expect(scrollbar).toHaveAttribute("aria-hidden", "true")
    expect(scrollbar).toHaveAttribute("data-visible", "false")
    expect(preview.querySelectorAll("button, a[download], [data-html-preview-actions]")).toHaveLength(0)

    frameMessage(frame, { type: "alook-html-scroll", scrollTop: 400, scrollHeight: 2400, clientHeight: 300 })
    expect(frame).toHaveAttribute("data-scroll-fade", "both")
    expect(buildHtmlPreviewScrollFadeMask("both")).toContain("transparent 0px, black 28px")
    expect(buildHtmlPreviewScrollFadeMask("both")).toContain("calc(100% - 36px)")
    expect(scrollbar).toHaveAttribute("data-visible", "true")

    act(() => { vi.advanceTimersByTime(800) })
    expect(scrollbar).toHaveAttribute("data-visible", "false")

    frameMessage(frame, { type: "alook-html-scroll", scrollTop: 2100, scrollHeight: 2400, clientHeight: 300 })
    expect(frame).toHaveAttribute("data-scroll-fade", "top")
    expect(buildHtmlPreviewScrollFadeMask("top")).toContain("transparent 0px, black 28px")
    expect(buildHtmlPreviewScrollFadeMask("top")).not.toContain("calc(100% - 36px)")

    fireEvent.pointerEnter(preview, { pointerType: "mouse" })
    expect(scrollbar).toHaveAttribute("data-visible", "true")

    vi.spyOn(scrollbar, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 300, left: 0, right: 10, width: 10, height: 300, x: 0, y: 0, toJSON: () => ({}),
    })
    fireEvent.pointerDown(scrollbar, { button: 0, clientY: 150, pointerId: 1 })
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "alook-html-scroll-to" }), "*")
    fireEvent(window, new Event("pointerup"))
  })
  it("prioritizes scroll-area-viewport over message-list-content parentElement when nested inside ScrollAreaContent", () => {
    const view = setup(
      <div data-slot="scroll-area-viewport" data-testid="outer-viewport">
        <div data-slot="scroll-area-content" data-testid="tall-content">
          <div data-message-list-content>
            <HtmlAttachmentPreview attachment={file} />
          </div>
        </div>
      </div>,
    )
    const viewport = view.getByTestId("outer-viewport")
    const content = view.getByTestId("tall-content")
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 500 })
    Object.defineProperty(content, "clientHeight", { configurable: true, value: 2400 })
    fireEvent(window, new Event("resize"))

    const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
    frameMessage(frame, { type: "alook-html-height", height: 1200 })
    expect(frame.style.height).toBe("250px")
    expect(readHtmlPreviewMemoryHeight(view.owner.queryClient, "a1")).toBe(1200)
  })
})

describe("HTML marker rendering", () => {
  it("splits inline text around a single block and consumes repeated markers", () => {
    const view = setup(<MessageBodyView plugins={{}} text="before [alook-html-preview](a1) after\n\n[alook-html-preview](a1)" attachments={[file]} />)
    expect(view.getAllByTestId(tid.htmlPreview("a1"))).toHaveLength(1)
    expect(view.container.textContent).toContain("before")
    expect(view.container.textContent).toContain("after")
    const body = view.container.querySelector(".message-markdown-blocks")!
    expect([...body.children].map((node) => node.tagName)).toEqual(["P", "DIV", "P"])
    expect(view.container.querySelector("p [data-html-preview]")).toBeNull()
  })
  it("does not execute typed HTML tags or let them duplicate a valid marker", () => {
    const literal = '<htmlpreview data-attachment-id="a1"></htmlpreview>'
    const body = (text: string) => <MessageBodyView plugins={{}} text={text} attachments={[file]} />
    const view = setup(body(literal))
    expect(view.container.querySelector("iframe")).toBeNull()
    view.rerender(view.tree(body("[alook-html-preview](a1)\n\n" + literal)))
    expect(view.getAllByTestId(tid.htmlPreview("a1"))).toHaveLength(1)
  })
  it("retains the current document when canonical attachments are republished", () => {
    const text = "[alook-html-preview](a1)"
    const body = () => <MessageBodyView plugins={{}} text={text} attachments={[{ ...file }]} />
    const view = setup(body())
    const frame = view.getByTestId(tid.htmlPreviewFrame("a1"))
    view.rerender(view.tree(body()))
    expect(view.getByTestId(tid.htmlPreviewFrame("a1"))).toBe(frame)
  })
  it("leaves an unassociated or escaped ID inert", () => {
    const view = setup(<MessageBodyView plugins={{}} text="[alook-html-preview](foreign)\n\n\\[alook-html-preview](a1)" attachments={[file]} />)
    expect(view.container.querySelector("iframe")).toBeNull()
  })
})


describe("HTML preview full message compositions", () => {
  it("removes an all-consumed attachment group and keeps mixed image indices stable", () => {
    const message = { id: "m1", type: "chat" as const, authorId: "viewer", grouped: false,
      content: "[alook-html-preview](a1)", attachments: [file] }
    const body = (mixed = false) => <Message m={{ ...message, attachments: mixed
      ? [file, { kind: "image", name: "photo.png", url: "/photo.png", width: 80, height: 80 }] : [file] }}
      onOpenThread={() => undefined} viewerUserId="viewer" />
    const view = setup(body())
    expect(view.getAllByTestId(tid.htmlPreview("a1"))).toHaveLength(1)
    const content = view.container.querySelector('[data-community-message-body]')!.closest(".relative.flex.min-w-0.flex-1.flex-col.gap-2")!
    expect(Array.from(content.children).filter(child => child.matches("div.flex.flex-col.gap-2") && child.childElementCount === 0)).toHaveLength(0)
    view.rerender(view.tree(body(true)))
    expect(view.getByTestId(tid.messageImage("m1", 1))).toBeInTheDocument()
    expect(view.queryByTestId(tid.messageImage("m1", 0))).toBeNull()
    expect(view.queryByTestId(tid.attachmentCard("demo.html"))).toBeNull()
  })

  it.each(["row", "opener"])("deduplicates preview and attachment cards in the actual %s", (surface) => {
    const message = {
      id: "m1", type: "chat" as const, authorId: "viewer", authorName: "Viewer", createdAt: "2026-10-28T08:00:00Z", grouped: false,
      content: "before [alook-html-preview](a1) after\n\n[alook-html-preview](a1)",
      attachments: [file, { ...file, id: "ordinary", name: "ordinary.txt", contentType: "text/plain" }],
    }
    opener.message = message
    const body = surface === "row"
      ? <Message m={message} onOpenThread={() => undefined} viewerUserId="viewer" />
      : <ThreadOpener parentMessageId="m1" parentChannelId="c1" serverId="s1" viewerUserId="viewer" />
    const view = setup(body)
    expect(view.getAllByTestId(tid.htmlPreview("a1"))).toHaveLength(1)
    expect(view.queryByTestId(tid.attachmentCard("demo.html"))).toBeNull()
    expect(view.getAllByTestId(tid.attachmentCard("ordinary.txt"))).toHaveLength(1)
    expect(view.container.textContent).toContain("before")
    expect(view.container.textContent).toContain("after")
  })
})
