import { createElement, useState, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, mockElementGeometry, render, waitFor } from "@/test/react-dom-harness"
import { renderToString } from "react-dom/server"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import type { CommunityNavigationController } from "@/contexts/community/route-frame"
import { CommunityMobileBackContext, CommunityMobileBackDrawer } from "./community-mobile-back-drawer"

const widthDescriptor = Object.getOwnPropertyDescriptor(document.documentElement, "clientWidth")
const pointDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  if (widthDescriptor) Object.defineProperty(document.documentElement, "clientWidth", widthDescriptor)
  else Reflect.deleteProperty(document.documentElement, "clientWidth")
  if (pointDescriptor) Object.defineProperty(document, "elementFromPoint", pointDescriptor)
  else Reflect.deleteProperty(document, "elementFromPoint")
})
function setup({ android = false, mobile = true, nativeInsets = null, child = <div data-testid="body">Conversation</div> }: {
  android?: boolean; mobile?: boolean; nativeInsets?: { left: number; right: number } | null; child?: ReactNode
} = {}) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(android ? "Android Chrome" : "iPhone Safari")
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 })
  const replace = vi.fn()
  const navigation = { replace, captureIntent: () => () => true } as unknown as CommunityNavigationController
  const value = { mobile, enabled: true, frameKey: "alice/dm1", targetHref: "/c/me/dm1", parentHref: "/c/me", navigation, nativeInsets }
  const tree = (next = value) => <CommunityMobileBackContext value={next}><CommunityMobileBackDrawer level="list">{child}</CommunityMobileBackDrawer></CommunityMobileBackContext>
  const view = render(tree())
  const start = (target: Element, x: number) => {
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target })
    fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: x, clientY: 100 }], changedTouches: [{ identifier: 1, clientX: x, clientY: 100 }] })
  }
  const ignored = () => view.container.querySelector(".community-back-drawer-viewport")!.hasAttribute("data-base-ui-swipe-ignore")
  return { view, value, tree, start, ignored, replace }
}

function acceptedRelease(test: ReturnType<typeof setup>) {
  const popup = test.view.container.querySelector<HTMLElement>(".community-back-drawer-popup")!
  const body = test.view.getByTestId("body")
  mockElementGeometry(popup, { width: 390, height: 844, offsetWidth: 390, offsetHeight: 844 })
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  Object.defineProperty(popup, "getAnimations", { configurable: true, value: () => [{ finished }] })
  test.start(body, 12)
  const touch = (clientX: number) => ({ identifier: 1, clientX, clientY: 100 })
  fireEvent.touchMove(body, { touches: [touch(110)], changedTouches: [touch(110)] })
  fireEvent.touchMove(body, { touches: [touch(320)], changedTouches: [touch(320)] })
  fireEvent.touchEnd(body, { touches: [], changedTouches: [touch(320)] })
  expect(popup).toHaveAttribute("data-closed")
  expect(test.replace).not.toHaveBeenCalled()
  return { popup, finish: async () => { await act(async () => { finish(); await finished }) } }
}

describe("public page Drawer input admission", () => {
  it.each([
    { name: "iOS app edge", android: false, mobile: true, enabled: true, x: 12, control: false, insets: null, allowed: true },
    { name: "Android browser app edge", android: true, mobile: true, enabled: true, x: 32, control: false, insets: null, allowed: true },
    { name: "trusted Android app edge", android: true, mobile: true, enabled: true, x: 48, control: false, insets: { left: .1, right: .1 }, allowed: true },
    { name: "trusted Android system edge", android: true, mobile: true, enabled: true, x: 20, control: false, insets: { left: .1, right: .1 }, allowed: false },
    { name: "outside app edge", android: false, mobile: true, enabled: true, x: 160, control: false, insets: null, allowed: false },
    { name: "button descendant", android: false, mobile: true, enabled: true, x: 12, control: true, insets: null, allowed: false },
    { name: "disabled navigation", android: false, mobile: true, enabled: false, x: 12, control: false, insets: null, allowed: false },
    { name: "desktop", android: false, mobile: false, enabled: true, x: 12, control: false, insets: null, allowed: false },
  ].flatMap(test => (["pointerdown", "touchstart"] as const).map(phase => ({ ...test, phase }))))(
    "admits nested $phase at $name without an ancestor ignore marker",
    ({ android, mobile, enabled, x, control, insets, allowed, phase }) => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(android ? "Android Chrome" : "iPhone Safari")
      if (insets) vi.stubGlobal("AlookBack", { postMessage: vi.fn() })
      Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 })
      const replace = vi.fn()
      const captureIntent = vi.fn(() => () => true)
      const navigation = { replace, captureIntent } as unknown as CommunityNavigationController
      const value = { mobile, enabled, frameKey: "alice/thread1", targetHref: "/c/channels/server1/thread1",
        parentHref: "/c/channels/server1/parent1", navigation, nativeInsets: insets }
      const view = render(<CommunityMobileBackContext value={value}>
        <CommunityMobileBackDrawer level="list">
          <div data-testid="outer-body">Retained parent</div>
          <CommunityMobileBackDrawer level="detail">
            {control ? <button><span data-testid="nested-body">Action</span></button> : <div data-testid="nested-body">Thread</div>}
          </CommunityMobileBackDrawer>
        </CommunityMobileBackDrawer>
      </CommunityMobileBackContext>)
      const [outer, inner] = view.container.querySelectorAll<HTMLElement>(".community-back-drawer-viewport")
      const dispatch = (target: Element, clientX: number, type: "pointerdown" | "touchstart") => {
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target })
        const event = type === "pointerdown"
          ? new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 100 })
          : new Event(type, { bubbles: true, cancelable: true })
        if (type === "pointerdown") Object.defineProperty(event, "pointerType", { value: "touch" })
        else {
          const touches = [{ identifier: 1, clientX, clientY: 100 }]
          Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: touches } })
        }
        fireEvent(target, event)
        return event
      }
      dispatch(view.getByTestId("outer-body"), 160, phase)
      expect(outer).toHaveAttribute("data-base-ui-swipe-ignore")
      const body = view.getByTestId("nested-body")
      const event = dispatch(body, x, phase)
      expect(outer).not.toHaveAttribute("data-base-ui-swipe-ignore")
      expect(inner.hasAttribute("data-base-ui-swipe-ignore")).toBe(!allowed)
      expect(body.closest("[data-base-ui-swipe-ignore]")).toBe(allowed ? null : inner)
      expect(event.defaultPrevented).toBe(false)
      expect(captureIntent).toHaveBeenCalledTimes(allowed && phase === "touchstart" ? 1 : 0)
      expect(replace).not.toHaveBeenCalled()
    },
  )

  it.each(["IME", "disabled", "cancelled intent"])("restores the original page after %s takes over during close", async (owner) => {
    const test = setup({ child: <><textarea data-testid="control" defaultValue="unfinished" /><div data-testid="body">Conversation</div></> })
    let current = true
    test.value.navigation.captureIntent = () => () => current
    const draft = test.view.getByTestId("control") as HTMLTextAreaElement
    draft.focus(); draft.scrollTop = 47
    const close = acceptedRelease(test)
    if (owner === "IME") fireEvent.compositionStart(draft)
    if (owner === "disabled") test.view.rerender(test.tree({ ...test.value, enabled: false }))
    if (owner === "cancelled intent") current = false
    await close.finish()
    await waitFor(() => expect(close.popup).toHaveAttribute("data-open"))
    expect(test.replace).not.toHaveBeenCalled()
    expect(test.view.getByTestId("control")).toBe(draft)
    expect(draft.value).toBe("unfinished")
    expect(draft.scrollTop).toBe(47)
  })

  it("restores the page when an actual overlay opens during close", async () => {
    function Overlay() {
      const [open, setOpen] = useState(false)
      return <><button onClick={() => setOpen(true)} data-testid="open-overlay">Open</button><Dialog open={open} onOpenChange={setOpen}>
        <DialogContent><DialogTitle>New owner</DialogTitle><DialogDescription>Opened after release</DialogDescription></DialogContent>
      </Dialog></>
    }
    const test = setup({ child: <><div data-testid="body">Conversation</div><Overlay /></> })
    const close = acceptedRelease(test)
    fireEvent.click(test.view.getByTestId("open-overlay"))
    await close.finish()
    await waitFor(() => expect(close.popup).toHaveAttribute("data-open"))
    expect(test.replace).not.toHaveBeenCalled()
    expect(test.view.getByRole("dialog")).toBeInTheDocument()
  })

  it.each([false, true])("restores a cancelled pending close without stealing newer focus=%s", async (newFocus) => {
    const test = setup({ child: <><textarea data-testid="control" /><div data-testid="body">Conversation</div></> })
    const draft = test.view.getByTestId("control")
    draft.focus()
    let originalCurrent = true
    let pendingCurrent = true
    test.value.navigation.captureIntent = (options) => options ? () => pendingCurrent : () => originalCurrent
    test.replace.mockImplementation(() => { originalCurrent = false })
    const close = acceptedRelease(test)
    await close.finish()
    await waitFor(() => expect(test.replace).toHaveBeenCalledExactlyOnceWith("/c/me", { transitionTypes: [] }))
    draft.blur()
    const other = document.createElement("input")
    if (newFocus) { document.body.appendChild(other); other.focus() }
    pendingCurrent = false
    test.view.rerender(test.tree({ ...test.value, enabled: true }))
    expect(close.popup).toHaveAttribute("data-open")
    expect(test.replace).toHaveBeenCalledOnce()
    await waitFor(() => expect(document.activeElement).toBe(newFocus ? other : draft))
    other.remove()
  })

  it.each([
    { name: "mobile detail textarea", mobile: true, targetHref: "/c/me/dm1", tag: "textarea" },
    { name: "desktop detail textarea", mobile: false, targetHref: "/c/me/dm1", tag: "textarea" },
    { name: "inactive list textarea", mobile: true, targetHref: "/c/me", tag: "textarea" },
    { name: "mobile detail input", mobile: true, targetHref: "/c/me/dm1", tag: "input" },
    { name: "desktop detail input", mobile: false, targetHref: "/c/me/dm1", tag: "input" },
    { name: "inactive list input", mobile: true, targetHref: "/c/me", tag: "input" },
  ])("preserves original SSR nodes and early input on $name", ({ mobile, targetHref, tag }) => {
    const navigation = { replace: vi.fn(), captureIntent: () => () => true } as unknown as CommunityNavigationController
    const value = { mobile, enabled: true, frameKey: "alice/dm1", targetHref, parentHref: "/c/me", navigation, nativeInsets: null }
    const tree = <CommunityMobileBackContext value={value}>
      <CommunityMobileBackDrawer level="list">{createElement(tag, { "data-testid": "original-ssr-draft", defaultValue: tag === "input" ? "SSR draft" : undefined })}</CommunityMobileBackDrawer>
    </CommunityMobileBackContext>
    const container = document.createElement("div")
    container.innerHTML = renderToString(tree)
    document.body.appendChild(container)
    const original = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(tag)!
    original.value = "typed before hydration"
    original.scrollTop = 47
    original.focus()
    const view = render(tree, { container, hydrate: true })
    expect(view.getByTestId("original-ssr-draft")).toBe(original)
    expect(original.value).toBe("typed before hydration")
    expect(original.scrollTop).toBe(47)
    expect(document.activeElement).toBe(original)
    expect(view.getAllByTestId("original-ssr-draft")).toHaveLength(1)
  })

  it.each([true, false])("keeps Escape bubbling with mobile=%s", (mobile) => {
    const test = setup({ mobile, child: <textarea data-testid="control" /> })
    const bubbled = vi.fn()
    window.addEventListener("keydown", bubbled)
    try {
      const input = test.view.getByTestId("control")
      input.focus()
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      fireEvent(input, event)
      expect(bubbled).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(false)
      expect(test.replace).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("keydown", bubbled)
    }
  })

  it.each([false, true])("admits app touch with Android browser=%s and no native bridge", (android) => {
    const test = setup({ android })
    test.start(test.view.getByTestId("body"), android ? 32 : 12)
    expect(test.ignored()).toBe(false)
    expect(test.replace).not.toHaveBeenCalled()
  })

  it("reserves actual native system edges and waits for trusted insets", () => {
    vi.stubGlobal("AlookBack", { postMessage: vi.fn() })
    const test = setup({ android: true })
    const body = test.view.getByTestId("body")
    test.start(body, 48)
    expect(test.ignored()).toBe(true)
    test.view.rerender(test.tree({ ...test.value, nativeInsets: { left: .1, right: .1 } }))
    test.start(body, 20)
    expect(test.ignored()).toBe(true)
    test.start(body, 48)
    expect(test.ignored()).toBe(false)
    test.start(body, 380)
    expect(test.ignored()).toBe(true)
  })

  it.each([
    { name: "input", child: <input data-testid="control" /> },
    { name: "textarea", child: <textarea data-testid="control" /> },
    { name: "rich editor child", child: <div contentEditable suppressContentEditableWarning><span data-testid="control">Editor</span></div> },
    { name: "textbox child", child: <div role="textbox"><span data-testid="control">Editor</span></div> },
    { name: "button", child: <button data-testid="control">Action</button> },
    { name: "link", child: <a href="#test" data-testid="control">Link</a> },
    { name: "swipe ignore", child: <div data-base-ui-swipe-ignore><span data-testid="control">Custom control</span></div> },
  ])("yields to $name without preventing its event", ({ child }) => {
    const test = setup({ child })
    const target = test.view.getByTestId("control")
    const event = new Event("touchstart", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "touches", { value: [{ identifier: 1, clientX: 12, clientY: 100 }] })
    fireEvent(target, event)
    expect(test.ignored()).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(test.replace).not.toHaveBeenCalled()
  })

  it("yields to a horizontally scrollable ancestor", () => {
    const test = setup({ child: <div style={{ overflowX: "auto" }}><span data-testid="control">Scroller</span></div> })
    const target = test.view.getByTestId("control")
    Object.defineProperties(target.parentElement!, { scrollWidth: { configurable: true, value: 300 }, clientWidth: { configurable: true, value: 100 } })
    test.start(target, 12)
    expect(test.ignored()).toBe(true)
  })

  it("yields the whole page while composition owns input", () => {
    const test = setup({ child: <><textarea data-testid="editor" /><div data-testid="body">Conversation</div></> })
    fireEvent.compositionStart(test.view.getByTestId("editor"))
    test.start(test.view.getByTestId("body"), 12)
    expect(test.ignored()).toBe(true)
    fireEvent.compositionEnd(test.view.getByTestId("editor"))
    test.start(test.view.getByTestId("body"), 12)
    expect(test.ignored()).toBe(false)
  })

  it("does not start or dismiss an actual overlay owner", () => {
    const close = vi.fn()
    const test = setup({ child: <><div data-testid="body">Conversation</div><Dialog open onOpenChange={close}>
      <DialogContent><DialogTitle>Overlay owner</DialogTitle><DialogDescription>Input belongs to the popup</DialogDescription></DialogContent>
    </Dialog></> })
    test.start(test.view.getByTestId("body"), 12)
    expect(test.ignored()).toBe(true)
    expect(close).not.toHaveBeenCalled()
    expect(test.replace).not.toHaveBeenCalled()
  })

  it("keeps the real draft node,offset and focus across disabled input and breakpoint changes", () => {
    const test = setup({ child: <textarea data-testid="control" defaultValue="unfinished" /> })
    const input = test.view.getByTestId("control") as HTMLTextAreaElement
    input.focus(); input.scrollTop = 57
    test.view.rerender(test.tree({ ...test.value, enabled: false }))
    expect(test.view.getByTestId("control")).toBe(input)
    expect(input.value).toBe("unfinished")
    expect(document.activeElement).toBe(input)
    test.view.rerender(test.tree({ ...test.value, mobile: false, frameKey: "alice/desktop" }))
    expect(test.view.getByTestId("control")).toBe(input)
    expect(input.scrollTop).toBe(57)
    expect(document.activeElement).toBe(input)
  })

  it("keeps right-click bubbling and default handling on the actual nonmodal parts", () => {
    const bubbled = vi.fn()
    const test = setup({ child: createElement("div", { onContextMenu: bubbled, "data-testid": "body" }, "Conversation") })
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
    fireEvent(test.view.getByTestId("body"), event)
    expect(bubbled).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
  })

  it("renders SSR content and retains one hydrated portal subtree through later frame updates", () => {
    const navigation = { replace: vi.fn(), captureIntent: () => () => true } as unknown as CommunityNavigationController
    const value = { mobile: true, enabled: true, frameKey: "alice/dm1", targetHref: "/c/me/dm1", parentHref: "/c/me", navigation, nativeInsets: null }
    const tree = (frameKey = value.frameKey) => <CommunityMobileBackContext value={{ ...value, frameKey }}>
      <CommunityMobileBackDrawer level="list"><textarea data-testid="ssr-draft" defaultValue="SSR draft" /></CommunityMobileBackDrawer>
    </CommunityMobileBackContext>
    const container = document.createElement("div")
    container.innerHTML = renderToString(tree())
    document.body.appendChild(container)
    expect(container.querySelector('[data-testid="ssr-draft"]')).toHaveValue("SSR draft")
    const view = render(tree(), { container, hydrate: true })
    const input = view.getByTestId("ssr-draft") as HTMLTextAreaElement
    expect(view.getAllByTestId("ssr-draft")).toHaveLength(1)
    input.value = "hydrated unfinished draft"
    input.scrollTop = 47
    input.focus()
    view.rerender(tree("alice/dm2"))
    expect(view.getByTestId("ssr-draft")).toBe(input)
    expect(input.value).toBe("hydrated unfinished draft")
    expect(input.scrollTop).toBe(47)
    expect(document.activeElement).toBe(input)
  })
})
