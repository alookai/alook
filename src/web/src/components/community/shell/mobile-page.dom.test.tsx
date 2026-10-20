import { useMemo, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, mockElementGeometry, screen, waitFor } from "@/test/react-dom-harness"
import { renderCommunity as render } from "@/test/community-owner-harness"
import { CommunityRouteContext, type CommunityNavigationController } from "@/contexts/community/route-frame"
import { MobilePageBackContext, type MobilePageBack } from "@/contexts/community/mobile-page-back"
import { normalizeCommunityHref } from "@/lib/community/community-route"
import { requestNativeBack } from "@/components/ui/native-back-layer"
import { MobilePage } from "./mobile-page"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { Message } from "@/components/community/messages/message"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))
afterEach(() => vi.restoreAllMocks())

function fixture() {
  let current = true
  let narrow = true
  let breakpoint: "mobile" | "desktop" = "mobile"
  let runtime!: ReturnType<typeof useCommunityRuntime>
  vi.spyOn(window, "matchMedia").mockImplementation(media => ({
    media, matches: media === "(max-width: 639px)" && narrow, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }))
  let request: MobilePageBack | null = null
  const replace = vi.fn()
  const navigation: CommunityNavigationController = {
    publishedHref: "/c/me/friends", navigationPending: false, pendingHref: null,
    captureIntent: () => () => current, replace, push: vi.fn(), pushImmediate: vi.fn(),
    resolveAndPush: vi.fn(async () => true), cancelPendingNavigation: vi.fn(),
  }
  const frame = { ...normalizeCommunityHref(navigation.publishedHref), revision: 0 }
  function Fixture({ active = true, children = <input aria-label="Page draft" /> }: { active?: boolean; children?: ReactNode }) {
    runtime = useCommunityRuntime()
    const registry = useMemo(() => ({ register: (next: MobilePageBack) => {
      request = next
      return () => { if (request === next) request = null }
    } }), [])
    return <CommunityRouteContext value={{ breakpoint, navigation, frame, ownerDeleteRouteScope: undefined }}>
      <MobilePageBackContext value={registry}>
        <MobilePage active={active} parentPath="/c/me">{children}</MobilePage>
      </MobilePageBackContext>
    </CommunityRouteContext>
  }
  return { Fixture, replace, navigation, invalidate: () => { current = false }, back: () => request?.("/c/me"),
    widen: () => { narrow = false }, retire: () => runtime.lifecycle.setState(state => ({ ...state, active: false })),
    desktop: () => { narrow = false; breakpoint = "desktop" },
  }
}

function holdExit(popup: HTMLElement) {
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const animations = vi.fn(() => [{ finished, effect: { getTiming: () => ({ duration: 220, iterations: 1 }) } }])
  Object.defineProperty(popup, "getAnimations", { configurable: true, value: animations })
  return { finish, animations }
}

describe("mobile page dismissal", () => {
  it.each([{ userAgent: "iPhone", start: 8 }, { userAgent: "Android WebView", start: 80 }])("follows an inline $userAgent page touch inside a vertical scroller, cancels, then commits one parent Back", async ({ userAgent, start }) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    const task = fixture()
    render(<task.Fixture><div style={{ overflowY: "auto" }} data-testid="page-scroll"><div data-testid="page-touch">Page body</div></div></task.Fixture>)
    const area = screen.getByTestId("page-touch")
    const popup = area.closest<HTMLElement>('[data-slot="mobile-page"]')!
    const scroller = screen.getByTestId("page-scroll")
    const restorePopup = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    const restoreScroll = mockElementGeometry(scroller, { width: 390, height: 600, clientWidth: 390, clientHeight: 600, scrollWidth: 390, scrollHeight: 1800 })
    const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area })
    const touch = (type: string, x: number, time: number) => {
      const point = { clientX: x, clientY: 100, identifier: 0, target: area }
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, {
        touches: { value: type === "touchend" || type === "touchcancel" ? [] : [point] },
        changedTouches: { value: [point] }, timeStamp: { value: time },
      })
      fireEvent(area, event)
    }
    try {
      touch("touchstart", start, 100)
      touch("touchmove", 170, 300)
      touch("touchmove", 220, 500)
      expect(popup).toHaveAttribute("data-swiping")
      expect(popup.style.transform).toContain("50px")
      touch("touchcancel", 220, 700)
      await waitFor(() => expect(popup).not.toHaveAttribute("data-swiping"))
      expect(popup).toHaveAttribute("data-open")
      expect(task.replace).not.toHaveBeenCalled()
      const animation = holdExit(popup)
      touch("touchstart", start, 1000)
      touch("touchmove", 170, 1200)
      touch("touchmove", 380, 1400)
      touch("touchend", 380, 1600)
      await waitFor(() => expect(popup).toHaveAttribute("data-closed"))
      expect(task.replace).not.toHaveBeenCalled()
      await waitFor(() => expect(animation.animations).toHaveBeenCalled())
      await act(async () => animation.finish())
      expect(task.replace).toHaveBeenCalledExactlyOnceWith("/c/me", { resume: true })
    } finally {
      restorePopup(); restoreScroll()
      if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest)
      else Reflect.deleteProperty(document, "elementFromPoint")
    }
  })

  it.each(["iPhone", "Android WebView"])("gives the page strip and message Reply separate start ownership on %s", async (userAgent) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    const task = fixture(), reply = vi.fn()
    render(<task.Fixture><Message m={{ id: "m1", type: "chat", authorId: "author", content: "Swipe text", createdAt: new Date(0).toISOString(), grouped: false }} onOpenThread={vi.fn()} onReply={reply} hoverCapable={false} /></task.Fixture>)
    const area = screen.getByText("Swipe text")
    const row = area.closest<HTMLElement>("[data-page-swipe-reply-row]")!
    const popup = area.closest<HTMLElement>('[data-slot="mobile-page"]')!
    const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    const restoreWidth = mockElementGeometry(document.documentElement, { clientWidth: 390, clientHeight: 844 })
    const originalHit = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
    const originalBridge = Object.getOwnPropertyDescriptor(window, "AlookNative")
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area })
    Object.defineProperty(window, "AlookNative", { configurable: true, value: { getSystemGestureRegion: () => '{"left":48,"right":48,"width":780}' } })
    const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number) => fireEvent[type](area, { pointerType: "touch", pointerId: 1, clientX: x, clientY: 100 })
    const touch = (type: "touchstart" | "touchmove" | "touchcancel", x: number) => {
      const point = { clientX: x, clientY: 100, identifier: 0, target: area }
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { touches: { value: type === "touchcancel" ? [] : [point] }, changedTouches: { value: [point] } })
      fireEvent(area, event)
    }
    try {
      if (userAgent === "Android WebView") {
        pointer("pointerDown", 8)
        touch("touchstart", 8)
        pointer("pointerMove", 78)
        touch("touchmove", 78)
        pointer("pointerUp", 78)
        touch("touchcancel", 78)
        expect(reply).not.toHaveBeenCalled()
        expect(popup).not.toHaveAttribute("data-swiping")
      }
      const start = userAgent === "iPhone" ? 8 : 24
      pointer("pointerDown", start)
      touch("touchstart", start)
      pointer("pointerMove", start + 50)
      touch("touchmove", start + 50)
      pointer("pointerMove", start + 100)
      touch("touchmove", start + 100)
      expect(popup).toHaveAttribute("data-swiping")
      expect(popup.style.transform).toContain("50px")
      expect(row.style.transform).toBe("")
      expect(reply).not.toHaveBeenCalled()
      touch("touchcancel", start + 100)
      pointer("pointerUp", start + 100)
      await waitFor(() => expect(popup).not.toHaveAttribute("data-swiping"))
      expect(task.replace).not.toHaveBeenCalled()
      pointer("pointerDown", 220)
      touch("touchstart", 220)
      pointer("pointerMove", 290)
      touch("touchmove", 290)
      expect(row.style.transform).toContain("translate3d")
      expect(popup).not.toHaveAttribute("data-swiping")
      pointer("pointerUp", 290)
      touch("touchcancel", 290)
      expect(reply).toHaveBeenCalledOnce()
      expect(task.replace).not.toHaveBeenCalled()
    } finally {
      restore(); restoreWidth()
      if (originalHit) Object.defineProperty(document, "elementFromPoint", originalHit)
      else Reflect.deleteProperty(document, "elementFromPoint")
      if (originalBridge) Object.defineProperty(window, "AlookNative", originalBridge)
      else Reflect.deleteProperty(window, "AlookNative")
    }
  })

  it.each([true, false].flatMap(withReply => [{ withReply, deltas: [32] }, { withReply, deltas: [76, 0] }]))("keeps a page-zone drag ($deltas,reply=$withReply) from becoming a message menu tap", async ({ deltas, withReply }) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    const task = fixture(), reply = vi.fn()
    render(<task.Fixture><Message m={{ id: "m1", type: "chat", authorId: "author", content: "Page drag text", createdAt: new Date(0).toISOString(), grouped: false }} onOpenThread={vi.fn()} onReply={withReply ? reply : undefined} onCopy={vi.fn()} hoverCapable={false} /></task.Fixture>)
    const area = screen.getByText("Page drag text")
    const row = area.closest<HTMLElement>("[data-page-swipe-reply-row]")!
    const capture = vi.fn()
    Object.defineProperty(row, "setPointerCapture", { configurable: true, value: capture })
    const width = mockElementGeometry(document.documentElement, { clientWidth: 390, clientHeight: 844 })
    const pointer = (type: string, x: number) => fireEvent(row, new PointerEvent(type, { bubbles: true, pointerType: "touch", pointerId: 19, clientX: x, clientY: 100 }))
    try {
      pointer("pointerdown", 8)
      for (const delta of deltas) pointer("pointermove", 8 + delta)
      pointer("pointerup", 8 + deltas.at(-1)!)
      fireEvent.click(row)
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
      expect(reply).not.toHaveBeenCalled()
      expect(capture).not.toHaveBeenCalled()
      expect(row.style.transform).toBe("")
      expect(task.replace).not.toHaveBeenCalled()
      pointer("pointerdown", 8)
      pointer("pointermove", 40)
      pointer("pointercancel", 40)
      fireEvent.click(row)
      expect(screen.queryAllByRole("menuitem")).toHaveLength(0)
      expect(reply).not.toHaveBeenCalled()
      pointer("pointerdown", 8)
      pointer("pointerup", 8)
      fireEvent.click(row)
      expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0)
    } finally { width() }
  })

  it("retains message-body Reply outside the page strip at the original100px start", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    const task = fixture(), reply = vi.fn()
    render(<task.Fixture><Message m={{ id: "m1", type: "chat", authorId: "author", content: "Body reply text", createdAt: new Date(0).toISOString(), grouped: false }} onOpenThread={vi.fn()} onReply={reply} hoverCapable={false} /></task.Fixture>)
    const row = screen.getByText("Body reply text").closest<HTMLElement>("[data-page-swipe-reply-row]")!
    const width = mockElementGeometry(document.documentElement, { clientWidth: 390, clientHeight: 844 })
    const pointer = (type: string, x: number) => fireEvent(row, new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 17, clientX: x, clientY: 100 }))
    try {
      pointer("pointerdown", 100)
      pointer("pointermove", 172)
      pointer("pointerup", 172)
      expect(reply).toHaveBeenCalledOnce()
      expect(task.replace).not.toHaveBeenCalled()
    } finally { width() }
  })

  it("reopens the retained current page on desktop while a completed mobile Back still waits for parent publication", async () => {
    const task = fixture()
    const view = render(<task.Fixture />)
    const input = screen.getByLabelText("Page draft")
    const popup = input.closest<HTMLElement>('[data-slot="mobile-page"]')!
    const animation = holdExit(popup)
    act(() => { task.back() })
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    await act(async () => animation.finish())
    expect(task.replace).toHaveBeenCalledExactlyOnceWith("/c/me", { resume: true })
    task.navigation.pendingHref = "/c/me"
    view.rerender(<task.Fixture />)
    expect(popup).toHaveAttribute("data-closed")
    task.desktop()
    view.rerender(<task.Fixture />)
    expect(screen.getByLabelText("Page draft")).toBe(input)
    expect(popup).toHaveAttribute("data-open")
    expect(input.closest("[inert]")).toBeNull()
    expect(task.replace).toHaveBeenCalledTimes(1)
  })

  it.each(["viewport", "owner"])("checks live %s authority before a queued completion", async (boundary) => {
    const task = fixture()
    render(<task.Fixture />)
    const popup = screen.getByLabelText("Page draft").closest<HTMLElement>('[data-slot="mobile-page"]')!
    const animation = holdExit(popup)
    act(() => { task.back() })
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    if (boundary === "viewport") task.widen()
    else task.retire()
    await act(async () => animation.finish())
    expect(task.replace).not.toHaveBeenCalled()
  })

  it("accepts close first and commits exactly one Back after the real completion boundary", async () => {
    const task = fixture()
    render(<task.Fixture />)
    const popup = screen.getByLabelText("Page draft").closest<HTMLElement>('[data-slot="mobile-page"]')!
    await waitFor(() => expect(popup).toHaveAttribute("data-open"))
    const animation = holdExit(popup)
    act(() => { expect(task.back()).toBe(true); expect(task.back()).toBe(true) })
    expect(popup).toHaveAttribute("data-closed")
    expect(task.replace).not.toHaveBeenCalled()
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    await act(async () => animation.finish())
    await waitFor(() => expect(task.replace).toHaveBeenCalledExactlyOnceWith("/c/me", { resume: true }))
  })

  it("retires a closing callback when a newer navigation supersedes it", async () => {
    const task = fixture()
    const view = render(<task.Fixture />)
    const popup = screen.getByLabelText("Page draft").closest<HTMLElement>('[data-slot="mobile-page"]')!
    const animation = holdExit(popup)
    act(() => { task.back() })
    await waitFor(() => expect(animation.animations).toHaveBeenCalled())
    task.invalidate()
    task.navigation.publishedHref = "/c/me/bots"
    view.rerender(<task.Fixture />)
    await act(async () => animation.finish())
    expect(task.replace).not.toHaveBeenCalled()
    expect(popup).toHaveAttribute("data-open")
  })

  it("keeps page semantics and gives inactive background neither Back nor focus ownership", async () => {
    const task = fixture()
    const view = render(<task.Fixture />)
    const input = screen.getByLabelText("Page draft")
    const popup = input.closest('[data-slot="mobile-page"]')!
    expect(popup).toHaveAttribute("role", "presentation")
    expect(input).not.toHaveFocus()
    expect(requestNativeBack(document)).toBe("none")
    view.rerender(<task.Fixture active={false} />)
    expect(popup.closest('[data-mobile-page-active="false"]')).toHaveAttribute("inert")
    expect(task.back()).toBeUndefined()
  })
})
