import {
  Fragment,
  cloneElement,
  createElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"

vi.mock("@base-ui/react/dialog", () => ({
  Dialog: {
    Root: ({ children, ...props }: ComponentProps<"div">) =>
      createElement("div", props, children),
    Trigger: ({ children, ...props }: ComponentProps<"button">) =>
      createElement("button", props, children),
    Portal: ({ children }: { children: ReactNode }) =>
      createElement(Fragment, null, children),
    Backdrop: ({ forceRender: _forceRender, ...props }:
      ComponentProps<"div"> & { forceRender?: boolean }) => createElement("div", props),
    Popup: ({ children, ...props }: ComponentProps<"div">) =>
      createElement("div", { ...props, "data-testid": "dialog-popup" }, children),
    Close: ({
      children,
      render: control,
      ...props
    }: ComponentProps<"button"> & { render?: ReactElement }) => control
      ? cloneElement(control, props, children)
      : createElement("button", props, children),
    Title: ({ children, ...props }: ComponentProps<"h2">) =>
      createElement("h2", props, children),
    Description: ({ children, ...props }: ComponentProps<"p">) =>
      createElement("p", props, children),
  },
}))

import { DialogContent } from "./dialog"

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
        createElement(DialogContent, { [name]: handler }, "Dialog body"),
      ))

      fire[name](rendered.getByTestId("dialog-popup"))
      expect(handler).toHaveBeenCalledOnce()
      expect(parentHandler).not.toHaveBeenCalled()
      rendered.unmount()
    }
  })

  it("keeps the close affordance touch-safe on mobile", () => {
    render(createElement(DialogContent, null, "Dialog body"))

    expect(screen.getByRole("button", { name: "Close" }))
      .toHaveClass("size-11", "sm:size-7")
  })
})
