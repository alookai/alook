import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, mockElementGeometry, render, screen, waitFor } from "@/test/react-dom-harness"
import { SwipeRoot, SwipePortal, SwipeViewport, SwipePopup, SwipeTitle } from "./swipe-container"
import { canStartSwipe } from "./swipe-gesture-policy"
import { Dialog, DialogContent, DialogTitle } from "./dialog"
import { ConversationActivityContext } from "@/contexts/community/conversation-activity"
import { requestNativeBack } from "./native-back-layer"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))

const hitTest = Object.getOwnPropertyDescriptor(document, "elementFromPoint")
afterEach(() => {
  vi.restoreAllMocks()
  if (hitTest) Object.defineProperty(document, "elementFromPoint", hitTest)
  else Reflect.deleteProperty(document, "elementFromPoint")
})

function Fixture({ changed, accept = true, direction = "right" }: { changed: (open: boolean) => void; accept?: boolean; direction?: "right" | "down" }) {
  const [open, setOpen] = useState(true)
  return <SwipeRoot kind="page" open={open} swipeDirection={direction} onOpenChange={(next) => { changed(next); if (accept) setOpen(next) }}>
    <SwipePortal><SwipeViewport><SwipePopup data-testid="swipe-popup">
      <SwipeTitle>Detail</SwipeTitle>
      <div data-testid="swipe-start">Drag here</div>
      <button>Keep button</button><input aria-label="Draft" />
      <div data-base-ui-swipe-ignore="" data-testid="reply-row">Reply gesture</div>
    </SwipePopup></SwipeViewport></SwipePortal>
  </SwipeRoot>
}

function touch(target: Element, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", x: number, y = 100, timeStamp?: number) {
  const point = { clientX: x, clientY: y, identifier: 0, target }
  const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    touches: { value: type === "touchEnd" || type === "touchCancel" ? [] : [point] },
    changedTouches: { value: [point] },
    ...(timeStamp === undefined ? {} : { timeStamp: { value: timeStamp } }),
  })
  fireEvent(target, event)
}

describe("shared Drawer interaction", () => {
  it("preserves click and context-menu propagation to their existing owners", () => {
    const click = vi.fn(), context = vi.fn()
    document.addEventListener("click", click)
    document.addEventListener("contextmenu", context)
    try {
      render(<Fixture changed={vi.fn()} />)
      const button = screen.getByRole("button", { name: "Keep button" })
      fireEvent.click(button)
      fireEvent.contextMenu(button)
      expect(click).toHaveBeenCalledOnce()
      expect(context).toHaveBeenCalledOnce()
    } finally {
      document.removeEventListener("click", click)
      document.removeEventListener("contextmenu", context)
    }
  })
  it("retires background modal visibility and Back ownership while retaining its owner state", async () => {
    const changed = vi.fn()
    const node = (active: boolean) => <ConversationActivityContext value={active}>
      <Dialog open onOpenChange={changed}><DialogContent data-testid="retained-dialog"><DialogTitle>Parent panel</DialogTitle></DialogContent></Dialog>
    </ConversationActivityContext>
    const view = render(node(true))
    const popup = screen.getByTestId("retained-dialog")
    expect(popup).toHaveAttribute("data-open")
    view.rerender(node(false))
    expect(popup).toHaveAttribute("hidden")
    expect(popup).toHaveAttribute("data-closed")
    expect(requestNativeBack(document)).toBe("none")
    expect(changed).not.toHaveBeenCalled()
    view.rerender(node(true))
    await waitFor(() => expect(screen.getByTestId("retained-dialog")).toHaveAttribute("data-open"))
  })
  it("restores a slow below-threshold release without changing controlled state", async () => {
    const changed = vi.fn()
    render(<Fixture changed={changed} />)
    const popup = screen.getByTestId("swipe-popup"), area = screen.getByTestId("swipe-start")
    const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area })
    touch(area, "touchStart", 120, 100, 100)
    touch(area, "touchMove", 170, 100, 300)
    touch(area, "touchMove", 190, 100, 1000)
    touch(area, "touchEnd", 190, 100, 1400)
    await waitFor(() => expect(popup).not.toHaveAttribute("data-swiping"))
    expect(popup).toHaveAttribute("data-open")
    expect(changed).not.toHaveBeenCalled()
    restore()
  })

  it.each([true, false])("accepts one release or restores a rejected controlled close (accept=%s)", async (accept) => {
    const changed = vi.fn()
    render(<Fixture changed={changed} accept={accept} />)
    const popup = screen.getByTestId("swipe-popup"), area = screen.getByTestId("swipe-start")
    const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area })
    touch(area, "touchStart", 120)
    touch(area, "touchMove", 170)
    touch(area, "touchMove", 360)
    touch(area, "touchEnd", 360)
    expect(changed).toHaveBeenCalledExactlyOnceWith(false)
    await waitFor(() => expect(popup).toHaveAttribute(accept ? "data-closed" : "data-open"))
    if (!accept) await waitFor(() => expect(popup).not.toHaveAttribute("data-ending-style"))
    restore()
  })

  it("follows its vertical placement and cancels when a second touch takes ownership", async () => {
    const changed = vi.fn()
    render(<Fixture changed={changed} direction="down" />)
    const popup = screen.getByTestId("swipe-popup"), area = screen.getByTestId("swipe-start")
    const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area })
    touch(area, "touchStart", 120, 120)
    touch(area, "touchMove", 120, 170)
    touch(area, "touchMove", 120, 220)
    expect(popup.style.transform).toContain("50px")
    fireEvent.touchMove(area, { touches: [
      { clientX: 120, clientY: 260, identifier: 0, target: area },
      { clientX: 170, clientY: 260, identifier: 1, target: area },
    ] })
    await waitFor(() => expect(popup).not.toHaveAttribute("data-swiping"))
    expect(changed).not.toHaveBeenCalled()
    expect(popup).toHaveAttribute("data-open")
    restore()
  })
  it("follows a permitted touch and cancels without requesting close", async () => {
    const changed = vi.fn()
    render(<Fixture changed={changed} />)
    const popup = await screen.findByTestId("swipe-popup")
    const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    const area = screen.getByTestId("swipe-start")
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area })
    touch(area, "touchStart", 120)
    touch(area, "touchMove", 170)
    await waitFor(() => { expect(popup).toHaveAttribute("data-swiping") })
    touch(area, "touchMove", 220)
    expect(popup.style.transform).toContain("50px")
    touch(area, "touchCancel", 220)
    await waitFor(() => { expect(popup).not.toHaveAttribute("data-swiping") })
    expect(changed).not.toHaveBeenCalled()
    expect(screen.getByTestId("swipe-popup")).toHaveAttribute("data-open")
    restore()
  })

  it("leaves touch buttons, inputs, reply rows and reserved edges outside drawer admission", async () => {
    const changed = vi.fn()
    render(<Fixture changed={changed} />)
    const popup = await screen.findByTestId("swipe-popup")
    const restore = mockElementGeometry(popup, { width: 390, height: 600, offsetWidth: 390, offsetHeight: 600, clientWidth: 390, clientHeight: 600 })
    for (const target of [screen.getByRole("button"), screen.getByRole("textbox"), screen.getByTestId("reply-row")]) {
      touch(target, "touchStart", 120)
      touch(target, "touchMove", 290)
      touch(target, "touchEnd", 290)
      expect(popup).not.toHaveAttribute("data-swiping")
    }
    const area = screen.getByTestId("swipe-start")
    touch(area, "touchStart", 8)
    touch(area, "touchMove", 290)
    touch(area, "touchEnd", 290)
    expect(changed).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "retained draft" } })
    expect(screen.getByRole("textbox")).toHaveValue("retained draft")
    restore()
  })

  it("yields overflow scrollers, multi-touch, selection, and disabled surfaces", () => {
    const root = document.createElement("div"), scroller = document.createElement("div"), target = document.createElement("span")
    root.appendChild(scroller)
    scroller.appendChild(target)
    document.body.appendChild(root)
    scroller.style.overflowX = "auto"
    const restore = mockElementGeometry(scroller, { clientWidth: 100, scrollWidth: 300 })
    const start = { target, root, x: 120, enabled: true, pointerType: "touch" }
    expect(canStartSwipe(start)).toBe(false)
    scroller.style.overflowX = "visible"
    expect(canStartSwipe(start)).toBe(true)
    expect(canStartSwipe({ ...start, touches: 2 })).toBe(false)
    expect(canStartSwipe({ ...start, pointerType: "mouse" })).toBe(false)
    expect(canStartSwipe({ ...start, enabled: false })).toBe(false)
    const selection = document.getSelection()!
    target.textContent = "selected content"
    selection.removeAllRanges()
    const range = document.createRange(); range.selectNodeContents(target); selection.addRange(range)
    expect(selection.toString()).toBe("selected content")
    expect(canStartSwipe(start)).toBe(false)
    selection.removeAllRanges(); restore(); root.remove()
  })
})
