import {
  createElement,
} from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))

import { Dialog, DialogContent, DialogTitle } from "./dialog"

const handlerNames = [
  "onClick",
  "onContextMenu",
  "onPointerCancel",
  "onPointerDown",
  "onPointerMove",
  "onPointerUp",
  "onTouchCancel",
  "onTouchEnd",
  "onTouchMove",
  "onTouchStart",
] as const

const fire = {
  onClick: fireEvent.click,
  onContextMenu: fireEvent.contextMenu,
  onPointerCancel: fireEvent.pointerCancel,
  onPointerDown: fireEvent.pointerDown,
  onPointerMove: fireEvent.pointerMove,
  onPointerUp: fireEvent.pointerUp,
  onTouchCancel: fireEvent.touchCancel,
  onTouchEnd: fireEvent.touchEnd,
  onTouchMove: fireEvent.touchMove,
  onTouchStart: fireEvent.touchStart,
}

describe("DialogContent", () => {
  it("runs popup interaction handlers and stops portal propagation", () => {
    for (const name of handlerNames) {
      const handler = vi.fn()
      const parentHandler = vi.fn()
      const rendered = render(createElement(
        "div",
        { [name]: parentHandler },
        createElement(Dialog, { defaultOpen: true }, createElement(DialogContent, { [name]: handler, "data-testid": "dialog-popup" }, createElement(DialogTitle, null, "Dialog body"))),
      ))

      fire[name](rendered.getByTestId("dialog-popup"))
      expect(handler).toHaveBeenCalledOnce()
      expect(parentHandler).not.toHaveBeenCalled()
      rendered.unmount()
    }
  })

  it("keeps the close affordance touch-safe on mobile", () => {
    render(createElement(Dialog, { defaultOpen: true }, createElement(DialogContent, null, createElement(DialogTitle, null, "Dialog body"))))

    expect(screen.getByRole("button", { name: "Close" }))
      .toHaveClass("size-11", "sm:size-7")
  })
})
