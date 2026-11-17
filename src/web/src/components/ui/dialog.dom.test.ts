import {
  createElement,
} from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))

import globalsCss from "../../app/globals.css?raw"
import technostalgiaCss from "../brand/technostalgia.module.css?raw"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog"
import { ConfirmDialog } from "./confirm-dialog"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog"

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

  it("prevents horizontal popup scrollbars from negative-margin footers while allowing long titles to wrap", () => {
    const safePopupRule = globalsCss.match(/\.app-safe-popup\s*\{([^}]+)\}/)?.[1] ?? ""
    expect(safePopupRule).toContain("overflow-x: hidden;")
    expect(safePopupRule).toContain("overflow-y: auto;")

    const dialogRendered = render(
      createElement(ConfirmDialog, {
        open: true,
        onOpenChange: () => {},
        title: "Leave /alook#5620/long-unbroken-thread-identifier?",
        description: "You'll stop receiving notifications for new replies.",
        confirmLabel: "Leave",
        onConfirm: () => {},
      }),
    )
    expect(dialogRendered.baseElement.querySelector('[data-slot="dialog-header"]')).toHaveClass("min-w-0")
    expect(dialogRendered.baseElement.querySelector('[data-slot="dialog-title"]')).toHaveClass("wrap-anywhere")
    dialogRendered.unmount()

    const alertRendered = render(
      createElement(
        AlertDialog,
        { defaultOpen: true },
        createElement(
          AlertDialogContent,
          null,
          createElement(
            AlertDialogHeader,
            null,
            createElement(AlertDialogTitle, null, "Report a problem with Claudette?"),
            createElement(AlertDialogDescription, null, "We’ll upload only program logs needed to diagnose the problem."),
          ),
          createElement(AlertDialogCancel, null, "Cancel"),
        ),
      ),
    )
    expect(alertRendered.baseElement.querySelector('[data-slot="alert-dialog-header"]')).toHaveClass("flex", "min-w-0", "text-left")
    expect(alertRendered.baseElement.querySelector('[data-slot="alert-dialog-title"]')).toHaveClass("wrap-anywhere")
    const alertDesc = alertRendered.baseElement.querySelector('[data-slot="alert-dialog-description"]')
    expect(alertDesc).not.toHaveClass("text-balance")
    expect(alertDesc?.className ?? "").not.toContain("text-pretty")
    expect(technostalgiaCss).toContain('[data-slot="alert-dialog-content"]')
    expect(technostalgiaCss).toContain('[data-slot="alert-dialog-title"]')
    expect(technostalgiaCss).toContain('[data-slot="alert-dialog-footer"]')
    expect(technostalgiaCss).toContain('[data-slot="context-menu-content"]')
  })
})
