import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"

const resizeHandle = vi.fn(() => null)

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
  useSheetResize: ({ defaultWidth }: { defaultWidth: number }) => ({
    width: defaultWidth,
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
  }),
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
  beforeEach(() => resizeHandle.mockClear())

  it("keeps sidecars non-modal, overlay-free, and resistant to outside dismissal", () => {
    const renderer = renderSheet({ mode: "sidecar", resizable: true })
    expect(renderer.root.findByType("sheet-root").props).toMatchObject({
      modal: false,
      disablePointerDismissal: true,
    })
    expect(renderer.root.findByType("sheet-content").props.showOverlay).toBe(false)
    expect(resizeHandle).toHaveBeenCalledOnce()
  })

  it("preserves the message-context sidecar's 420px desktop width", () => {
    const renderer = renderSheet({ mode: "sidecar", width: "md", resizable: true })
    expect(
      renderer.root.findByType("sheet-content").props.style["--community-sheet-width"],
    ).toBe("420px")
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
    },
  )

  it("uses one CSS-only 640px geometry checkpoint and a 44px mobile close target", () => {
    const renderer = renderSheet({ mode: "preview", width: "lg", resizable: true })
    const content = renderer.root.findByType("sheet-content")
    expect(content.props.className).toContain("data-[side=right]:h-dvh")
    expect(content.props.className).toContain("data-[side=right]:w-screen")
    expect(content.props.className).toContain("data-[side=right]:sm:inset-y-2")
    expect(content.props.className).toContain("data-[side=right]:sm:w-[min(var(--community-sheet-width),calc(100vw-1rem))]")
    expect(content.props.style["--community-sheet-width"]).toBe("520px")
    expect(renderer.root.findByType("sheet-close").props.render.props.className).toContain("size-11")
    expect(resizeHandle).toHaveBeenCalledOnce()
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
