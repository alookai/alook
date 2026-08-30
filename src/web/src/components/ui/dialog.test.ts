import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"

vi.mock("@base-ui/react/dialog", () => ({
  Dialog: {
    Root: ({ children, ...props }: React.ComponentProps<"div">) =>
      React.createElement("mock-dialog-root", props, children),
    Trigger: ({ children, ...props }: React.ComponentProps<"button">) =>
      React.createElement("mock-dialog-trigger", props, children),
    Portal: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Backdrop: (props: React.ComponentProps<"div">) =>
      React.createElement("mock-dialog-backdrop", props),
    Popup: ({ children, ...props }: React.ComponentProps<"div">) =>
      React.createElement("mock-dialog-popup", props, children),
    Close: ({ children, ...props }: React.ComponentProps<"button">) =>
      React.createElement("mock-dialog-close", props, children),
    Title: ({ children, ...props }: React.ComponentProps<"h2">) =>
      React.createElement("mock-dialog-title", props, children),
    Description: ({ children, ...props }: React.ComponentProps<"p">) =>
      React.createElement("mock-dialog-description", props, children),
  },
}))

import { DialogContent } from "./dialog"

describe("DialogContent", () => {
  it("runs popup interaction handlers and stops portal propagation", () => {
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
    const handlers = Object.fromEntries(handlerNames.map((name) => [name, vi.fn()]))
    let renderer: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        React.createElement(DialogContent, handlers, "Dialog body"),
      )
    })

    const popup = renderer!.root.findByType("mock-dialog-popup")
    for (const name of handlerNames) {
      const event = { stopPropagation: vi.fn() }
      act(() => popup.props[name](event))
      expect(handlers[name]).toHaveBeenCalledOnce()
      expect(handlers[name]).toHaveBeenCalledWith(event)
      expect(event.stopPropagation).toHaveBeenCalledOnce()
    }
  })
})
