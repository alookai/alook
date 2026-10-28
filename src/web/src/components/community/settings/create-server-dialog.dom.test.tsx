import React from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@/test/react-dom-harness"
import { CreateServerDialog } from "./create-server-dialog"

vi.mock("@/components/avatar", () => ({ SeededBackdrop: () => null }))
vi.mock("../image-crop-dialog", () => ({ ImageCropDialog: () => null }))

describe("CreateServerDialog presentation", () => {
  it("keeps normal creation in a dialog and submits a trimmed name", () => {
    const onCreateServer = vi.fn()
    const onClose = vi.fn()
    const view = render(<CreateServerDialog onClose={onClose} onCreateServer={onCreateServer} />)
    const input = screen.getByRole("textbox", { name: "Server name" })
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(view.container.contains(input)).toBe(false)
    fireEvent.change(input, { target: { value: "  Studio  " } })
    fireEvent.click(screen.getByRole("button", { name: "Create server" }))
    expect(onCreateServer).toHaveBeenCalledExactlyOnceWith("Studio", undefined)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders controlled preview names inline without taking focus", () => {
    const outside = document.createElement("button")
    document.body.appendChild(outside)
    outside.focus()
    const view = render(<CreateServerDialog onClose={vi.fn()} previewName="Studio" />)
    try {
      const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Server name"]')!
      expect(input.value).toBe("Studio")
      expect(view.container.querySelector('[data-slot="dialog-content"]')?.hasAttribute("inert")).toBe(true)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(outside)
      view.rerender(<CreateServerDialog onClose={vi.fn()} previewName="Studio team" />)
      expect(input.value).toBe("Studio team")
    } finally {
      outside.remove()
    }
  })
})
