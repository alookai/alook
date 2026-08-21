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
    SheetClose: pass("sheet-close"),
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

import { CommunitySheet, CommunitySheetFooter } from "./community-sheet"

function renderSheet(
  props: Partial<React.ComponentProps<typeof CommunitySheet>> &
    Pick<React.ComponentProps<typeof CommunitySheet>, "mode">,
) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        CommunitySheet,
        { open: true, onOpenChange: vi.fn(), ...props } as React.ComponentProps<typeof CommunitySheet>,
        React.createElement("div", null, "content"),
      ),
    )
  })
  return renderer
}

describe("CommunitySheet contracts", () => {
  beforeEach(() => {
    resizeHandle.mockClear()
    resizeHook.mockClear()
  })

  it("keeps sidecars non-modal, overlay-free, and resistant to outside dismissal", () => {
    const renderer = renderSheet({ mode: "sidecar" })
    expect(renderer.root.findByType("sheet-root").props).toMatchObject({
      modal: false,
      disablePointerDismissal: true,
    })
    expect(renderer.root.findByType("sheet-content").props.showOverlay).toBe(false)
    expect(resizeHook).toHaveBeenCalledWith()
    expect(resizeHandle).toHaveBeenCalledOnce()
  })

  it.each(["task", "preview"] as const)(
    "keeps %s surfaces modal with the shared overlay and dismissal defaults",
    (mode) => {
      const renderer = renderSheet({ mode })
      expect(renderer.root.findByType("sheet-root").props).toMatchObject({
        modal: true,
        disablePointerDismissal: false,
      })
      expect(renderer.root.findByType("sheet-content").props.showOverlay).toBe(true)
      if (mode === "task") {
        expect(resizeHook).not.toHaveBeenCalled()
        expect(resizeHandle).not.toHaveBeenCalled()
      } else {
        expect(resizeHook).toHaveBeenCalledWith()
        expect(resizeHandle).toHaveBeenCalledOnce()
      }
    },
  )

  it("uses one CSS-only 640px geometry checkpoint and a 44px mobile close target", () => {
    const renderer = renderSheet({ mode: "preview" })
    const content = renderer.root.findByType("sheet-content")
    expect(content.props.className).toContain("data-[side=right]:h-dvh")
    expect(content.props.className).toContain("data-[side=right]:w-screen")
    expect(content.props.className).toContain("data-[side=right]:sm:inset-y-2")
    expect(content.props.className).toContain("data-[side=right]:sm:w-[min(var(--community-sheet-width),var(--community-sheet-max-width),calc(100vw-1rem))]")
    expect(content.props.style["--community-sheet-width"]).toBe("480px")
    expect(content.props.style["--community-sheet-max-width"]).toBe("80vw")
    expect(renderer.root.findByType("sheet-close").props.render.props.className).toContain("size-11")
    expect(resizeHandle).toHaveBeenCalledOnce()
  })

  it("keeps task width fixed without resize policy state", () => {
    const renderer = renderSheet({ mode: "task" })
    const content = renderer.root.findByType("sheet-content")
    expect(content.props.style["--community-sheet-width"]).toBe("448px")
    expect(content.props.style["--community-sheet-max-width"]).toBe("100vw")
    expect(resizeHook).not.toHaveBeenCalled()
    expect(resizeHandle).not.toHaveBeenCalled()
  })

  it("enforces 44px mobile footer targets without changing desktop button sizing", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          CommunitySheetFooter,
          null,
          React.createElement("button", null, "Save"),
        ),
      )
    })
    const footer = renderer.root.findByType("sheet-footer")
    expect(footer.props.className).toContain("**:data-[slot=button]:min-h-11")
    expect(footer.props.className).toContain("sm:**:data-[slot=button]:min-h-0")
  })
})
