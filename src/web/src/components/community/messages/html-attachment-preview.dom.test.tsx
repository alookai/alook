import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { ApplicationOwnerProvider, createApplicationOwner, retireApplicationOwner } from "@/lib/application-owner"
import { Message } from "./message"
import { ThreadOpener } from "./thread-opener"
import { HtmlAttachmentPreview } from "./html-attachment-preview"
import { MessageBodyView } from "./message-body-view"
import { tid } from "@/lib/community/testids"
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
afterEach(() => { for (const owner of owners.splice(0)) owner.queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); theme.resolvedTheme = "light"; vi.useRealTimers() })

describe("HTML attachment frame", () => {
  it("keeps the filename out of content and groups floating preview actions", () => {
    const view = setup()
    const actions = view.getByRole("group", { name: "HTML preview actions" })
    expect(view.queryByText(file.name)).toBeNull()
    expect(actions).toContainElement(view.getByTestId(tid.htmlPreviewDownload("a1")))
    expect(actions.querySelectorAll("button")).toHaveLength(1)
    expect(view.queryByRole("button", { name: /Expand HTML preview|Close fullscreen preview/ })).toBeNull()
    expect(view.queryByRole("dialog")).toBeNull()
    expect(view.getByTestId(tid.htmlPreview("a1"))).not.toHaveAttribute("aria-modal")
    expect(view.getByTestId(tid.htmlPreview("a1"))).toHaveAccessibleName(file.name)
  })
  it("keeps one opaque-origin frame and clamps valid current-frame measurements", () => {
    const view = setup()
    const frame = view.getByTestId(tid.htmlPreviewFrame("a1")) as HTMLIFrameElement
    expect(frame).toHaveAttribute("src", `${file.url}?preview=html`)
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
    expect(frame.style.height).toBe("2000px")
    frameMessage(frame, { type: "alook-html-height", height: 1 })
    expect(frame.style.height).toBe("80px")
    frameMessage(frame, { type: "alook-html-ready" })
    expect(view.getByTestId(tid.htmlPreview("a1"))).toHaveAttribute("data-html-preview-status", "ready")
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
    expect(loading.textContent).toBe("")
    expect(loading.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
    expect(preview.style.height).toBe("320px")
    expect(view.queryByTestId(tid.htmlPreviewFrame("a1"))).toBeNull()
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
  it("turns missing readiness into a single failure block", () => {
    vi.useFakeTimers()
    const view = setup()
    act(() => vi.advanceTimersByTime(15_000))
    expect(view.queryByTestId(tid.htmlPreviewFrame("a1"))).toBeNull()
    expect(view.getByRole("status")).toHaveTextContent("Preview unavailable")
    expect(view.getAllByTestId(tid.htmlPreview("a1"))).toHaveLength(1)
    expect(view.getByTestId(tid.htmlPreviewDownload("a1"))).toBeEnabled()
    expect(view.queryByRole("status", { name: "Loading preview" })).toBeNull()
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
