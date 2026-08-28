import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { resizeHandle, resizeHook } = vi.hoisted(() => ({
  resizeHandle: vi.fn(() => null),
  resizeHook: vi.fn(() => ({
    width: 480,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  })),
}))

vi.mock("@/components/ui/sheet", () => {
  const pass = (type: string) =>
    function Passthrough({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
      return React.createElement(type, props, children)
    }
  return {
    Sheet: pass("sheet-root"),
    SheetBody: pass("sheet-body"),
    SheetContent: pass("sheet-content"),
    SheetDescription: pass("sheet-description"),
    SheetFooter: pass("sheet-footer"),
    SheetHeader: pass("sheet-header"),
    SheetTitle: pass("sheet-title"),
  }
})

vi.mock("@/components/ui/button", () => ({
  Button: (props: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("button", props, props.children),
}))

vi.mock("@/components/ui/sheet-resize-handle", () => ({
  useSheetResize: resizeHook,
  SheetResizeHandle: (props: Record<string, unknown>) => resizeHandle(props),
}))

import { CommunitySheet } from "./community-sheet"

function renderSheet(
  props: Partial<React.ComponentProps<typeof CommunitySheet>> = {},
) {
  const onOpenChange = props.onOpenChange ?? vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        CommunitySheet,
        { open: true, onOpenChange, title: "Sheet title", ...props },
        React.createElement("div", null, "content"),
      ),
    )
  })
  return { renderer, onOpenChange }
}

describe("CommunitySheet contracts", () => {
  beforeEach(() => {
    resizeHandle.mockClear()
    resizeHook.mockClear()
  })

  it("makes every community surface modal, overlay-backed, and 480px on desktop", () => {
    const { renderer } = renderSheet()
    expect(renderer.root.findByType("sheet-root").props.modal).toBe(true)
    const content = renderer.root.findByType("sheet-content")
    expect(content.props.showOverlay).toBe(true)
    expect(content.props.style["--community-sheet-width"]).toBe("480px")
    expect(content.props.style["--community-sheet-max-width"]).toBe("80vw")
    expect(resizeHook).not.toHaveBeenCalled()
    expect(resizeHandle).not.toHaveBeenCalled()
  })

  it("uses the primitive resize policy at the caller's desktop width", () => {
    const { renderer } = renderSheet({ resizable: true, desktopWidth: 672 })
    const content = renderer.root.findByType("sheet-content")
    expect(content.props.style["--community-sheet-width"]).toBe("480px")
    expect(content.props.style["--community-sheet-max-width"]).toBe("80vw")
    expect(resizeHook).toHaveBeenCalledWith({ defaultWidth: 672 })
    expect(resizeHandle).toHaveBeenCalledOnce()
  })

  it("accepts a compact desktop width while keeping the internal 320px floor", () => {
    const compact = renderSheet({ desktopWidth: 380 }).renderer.root.findByType("sheet-content")
    expect(compact.props.style["--community-sheet-width"]).toBe("380px")

    const clamped = renderSheet({ desktopWidth: 200 }).renderer.root.findByType("sheet-content")
    expect(clamped.props.style["--community-sheet-width"]).toBe("320px")
  })

  it("uses one CSS-only 640px geometry checkpoint and a 44px mobile close", () => {
    const { renderer } = renderSheet()
    const content = renderer.root.findByType("sheet-content")
    expect(content.props.className).toContain("data-[side=right]:h-dvh")
    expect(content.props.className).toContain("data-[side=right]:w-screen")
    expect(content.props.className).toContain("data-[side=right]:sm:inset-y-2")
    expect(content.props.className).toContain(
      "data-[side=right]:sm:w-[clamp(20rem,var(--community-sheet-width),min(var(--community-sheet-max-width),calc(100vw-1rem)))]",
    )
    expect(renderer.root.findByProps({ "aria-label": "Close" }).props.className).toContain("size-11")
  })

  it("keeps the header to title and description, and routes every close entry through one request", () => {
    const onOpenChange = vi.fn()
    const { renderer } = renderSheet({
      onOpenChange,
      title: "Structured title",
      description: "Structured description",
      bodyClassName: "body-policy",
      footer: (requestClose) => React.createElement(
        "button",
        { "data-footer-close": true, onClick: requestClose },
        "Done",
      ),
    })

    expect(renderer.root.findByType("sheet-title").children).toEqual(["Structured title"])
    expect(renderer.root.findByType("sheet-description").children).toEqual(["Structured description"])
    const header = renderer.root.findByType("sheet-header")
    expect(header.findAllByType("a")).toHaveLength(0)
    expect(header.findAllByProps({ className: "flex min-w-0 items-start gap-3" })).toHaveLength(0)
    expect(renderer.root.findAllByType("button").filter((node) => node.props["aria-label"] === "Close"))
      .toHaveLength(1)
    expect(renderer.root.findByType("sheet-body").props.className).toBe("body-policy")
    expect(renderer.root.findByType("sheet-footer").props.className).toContain(
      "**:data-[slot=button]:min-h-11",
    )
    expect(renderer.root.findByType("sheet-footer").props.className).toContain("flex-row")
    expect(renderer.root.findByType("sheet-footer").props.className).toContain("items-center")
    expect(renderer.root.findByType("sheet-footer").props.className).toContain("justify-end")

    act(() => renderer.root.findByType("sheet-root").props.onOpenChange(false))
    act(() => renderer.root.findByProps({ "aria-label": "Close" }).props.onClick())
    act(() => renderer.root.findByProps({ "data-footer-close": true }).props.onClick())
    expect(onOpenChange).toHaveBeenNthCalledWith(1, false)
    expect(onOpenChange).toHaveBeenNthCalledWith(2, false)
    expect(onOpenChange).toHaveBeenNthCalledWith(3, false)
  })

  it("adds a shrink-safe leading column without replacing the standard title primitives", () => {
    const leading = React.createElement("leading-avatar", { size: 32 })
    const { renderer } = renderSheet({
      title: "Bot name",
      description: "Live · Activity log",
      headerLeading: leading,
      footer: React.createElement(
        React.Fragment,
        null,
        React.createElement("button", { "data-action": "cancel" }, "Cancel"),
        React.createElement("button", { "data-action": "primary" }, "Save"),
      ),
    })

    const header = renderer.root.findByType("sheet-header")
    expect(header.findByProps({ className: "flex min-w-0 items-start gap-3" })).toBeTruthy()
    expect(header.findByProps({ "data-slot": "sheet-header-leading" })
      .findByType("leading-avatar").props.size)
      .toBe(32)
    const textColumn = header.findByProps({ className: "flex min-w-0 flex-1 flex-col gap-1" })
    expect(textColumn.findByType("sheet-title").children).toEqual(["Bot name"])
    expect(textColumn.findByType("sheet-description").children).toEqual(["Live · Activity log"])
    expect(renderer.root.findByType("sheet-footer").findAllByType("button")
      .map((button) => button.props["data-action"]))
      .toEqual(["cancel", "primary"])
  })
})
