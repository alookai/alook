import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"

const { resizeHandle, resizeHook, sheetProps } = vi.hoisted(() => ({
  resizeHandle: vi.fn(() => null),
  resizeHook: vi.fn(() => ({
    width: 480,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  })),
  sheetProps: new Map<string, Record<string, unknown>>(),
}))

vi.mock("@/components/ui/sheet", () => {
  const pass = (type: string) =>
    function Passthrough({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
      sheetProps.set(type, props)
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
  sheetProps.clear()
  const renderer = render(React.createElement(
    CommunitySheet,
    { open: true, onOpenChange, title: "Sheet title", ...props },
    React.createElement("div", null, "content"),
  ))
  return { renderer, onOpenChange }
}

describe("CommunitySheet contracts", () => {
  beforeEach(() => {
    resizeHandle.mockClear()
    resizeHook.mockClear()
  })

  it("makes every community surface modal, overlay-backed, and 480px on desktop", () => {
    const { renderer } = renderSheet()
    expect(sheetProps.get("sheet-root")?.modal).toBe(true)
    const content = sheetProps.get("sheet-content")!
    expect(content.showOverlay).toBe(true)
    expect((content.style as Record<string, string>)["--community-sheet-width"]).toBe("480px")
    expect((content.style as Record<string, string>)["--community-sheet-max-width"]).toBe("80vw")
    expect(resizeHook).not.toHaveBeenCalled()
    expect(resizeHandle).not.toHaveBeenCalled()
  })

  it("uses the primitive resize policy at the caller's desktop width", () => {
    const { renderer } = renderSheet({ resizable: true, desktopWidth: 672 })
    const content = sheetProps.get("sheet-content")!
    expect((content.style as Record<string, string>)["--community-sheet-width"]).toBe("480px")
    expect((content.style as Record<string, string>)["--community-sheet-max-width"]).toBe("80vw")
    expect(resizeHook).toHaveBeenCalledWith({ defaultWidth: 672 })
    expect(resizeHandle).toHaveBeenCalledOnce()
  })

  it("accepts a compact desktop width while keeping the internal 320px floor", () => {
    renderSheet({ desktopWidth: 380 })
    const compact = sheetProps.get("sheet-content")!
    expect((compact.style as Record<string, string>)["--community-sheet-width"]).toBe("380px")

    renderSheet({ desktopWidth: 200 })
    const clamped = sheetProps.get("sheet-content")!
    expect((clamped.style as Record<string, string>)["--community-sheet-width"]).toBe("320px")
  })

  it("uses one CSS-only 640px geometry checkpoint and a 44px mobile close", () => {
    const { renderer } = renderSheet()
    const content = sheetProps.get("sheet-content")!
    expect(content.className).toContain("data-[side=right]:h-dvh")
    expect(content.className).toContain("data-[side=right]:w-screen")
    expect(content.className).toContain("data-[side=right]:sm:inset-y-2")
    expect(content.className).toContain(
      "data-[side=right]:sm:w-[clamp(20rem,var(--community-sheet-width),min(var(--community-sheet-max-width),calc(100vw-1rem)))]",
    )
    expect(renderer.getByRole("button", { name: "Close" }).className).toContain("size-11")
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

    expect(renderer.container.querySelector("sheet-title")).toHaveTextContent("Structured title")
    expect(renderer.container.querySelector("sheet-description")).toHaveTextContent("Structured description")
    const header = renderer.container.querySelector("sheet-header")!
    expect(header.querySelectorAll("a")).toHaveLength(0)
    expect(header.querySelectorAll('[class="flex min-w-0 items-start gap-3"]')).toHaveLength(0)
    expect(renderer.getAllByRole("button", { name: "Close" })).toHaveLength(1)
    expect(sheetProps.get("sheet-body")?.className).toBe("body-policy")
    expect(sheetProps.get("sheet-footer")?.className).toContain(
      "**:data-[slot=button]:min-h-11",
    )
    expect(sheetProps.get("sheet-footer")?.className).toContain("flex-row")
    expect(sheetProps.get("sheet-footer")?.className).toContain("items-center")
    expect(sheetProps.get("sheet-footer")?.className).toContain("justify-end")

    act(() => (sheetProps.get("sheet-root")?.onOpenChange as (open: boolean) => void)(false))
    fireEvent.click(renderer.getByRole("button", { name: "Close" }))
    fireEvent.click(renderer.container.querySelector('[data-footer-close="true"]')!)
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

    const header = renderer.container.querySelector("sheet-header")!
    expect(header.querySelector('[class="flex min-w-0 items-start gap-3"]')).toBeInTheDocument()
    expect(header.querySelector('[data-slot="sheet-header-leading"] leading-avatar'))
      .toHaveAttribute("size", "32")
    const textColumn = header.querySelector('[class="flex min-w-0 flex-1 flex-col gap-1"]')!
    expect(textColumn.querySelector("sheet-title")).toHaveTextContent("Bot name")
    expect(textColumn.querySelector("sheet-description")).toHaveTextContent("Live · Activity log")
    expect([...renderer.container.querySelectorAll("sheet-footer button")]
      .map((button) => button.getAttribute("data-action")))
      .toEqual(["cancel", "primary"])
  })
})
