import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { appBackdropClassName } from "./app-edge-fade"
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger, DialogOverlay } from "./dialog"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTitle, AlertDialogTrigger } from "./alert-dialog"
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "./sheet"
import { requestNativeBack } from "./native-back-layer"

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))

const kinds = {
  dialog: { Root: Dialog, Trigger: DialogTrigger, Content: DialogContent, Title: DialogTitle, Close: DialogClose },
  "alert-dialog": { Root: AlertDialog, Trigger: AlertDialogTrigger, Content: AlertDialogContent, Title: AlertDialogTitle, Close: AlertDialogCancel },
  sheet: { Root: Sheet, Trigger: SheetTrigger, Content: SheetContent, Title: SheetTitle, Close: SheetClose },
}

describe("shared app backdrop", () => {
  it.each(["dialog", "alert-dialog", "sheet"] as const)("preserves %s dismissal, focus and Back with inert shared edges", async (kind) => {
    const { Root, Trigger, Content, Title, Close } = kinds[kind]
    const user = setupUser()
    render(<Root>
      <Trigger>Open</Trigger>
      <Content>
        <Title>Example</Title>
        <input aria-label="Draft" />
        <Close>Finish</Close>
      </Content>
    </Root>)
    const trigger = screen.getByRole("button", { name: "Open" })
    const role = kind === "alert-dialog" ? "alertdialog" : "dialog"
    await user.click(trigger)
    await screen.findByRole(role)
    const overlay = document.querySelector<HTMLElement>(`[data-slot="${kind}-overlay"]`)!
    expect(overlay).toHaveAttribute("data-open")
    expect(overlay).toHaveClass(...appBackdropClassName.split(" "))
    const edges = overlay.querySelector<HTMLElement>('[data-slot="app-edge-fade"]')!
    expect(edges).toHaveAttribute("aria-hidden", "true")
    expect(edges).toHaveClass("pointer-events-none")
    expect(Array.from(edges.children, (edge) => edge.getAttribute("data-app-edge")).sort()).toEqual(["bottom", "left", "right", "top"])
    expect(edges.querySelector("button, input, a, [tabindex]")).toBeNull()
    if (kind === "alert-dialog") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Finish" })).toHaveFocus())
    }
    await user.click(overlay)
    if (kind === "alert-dialog") {
      expect(screen.getByRole(role)).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Finish" }))
    }
    await waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument())
    if (kind === "alert-dialog") {
      await waitFor(() => expect(trigger).toHaveFocus())
    } else {
      expect(document.activeElement).toBe(document.body)
    }
    await user.click(trigger)
    await screen.findByRole(role)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    await user.click(trigger)
    await screen.findByRole(role)
    act(() => { expect(requestNativeBack(document)).toBe("requested") })
    await waitFor(() => expect(screen.queryByRole(role)).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(requestNativeBack(document)).toBe("none")
  })

  it("preserves overlay caller props and children alongside the decorative edges", () => {
    const clicked = vi.fn()
    render(<Dialog defaultOpen>
      <DialogOverlay data-testid="custom-overlay" onClick={clicked}>
        <span data-testid="overlay-child">Decoration</span>
      </DialogOverlay>
    </Dialog>)
    const overlay = screen.getByTestId("custom-overlay")
    expect(overlay).toContainElement(screen.getByTestId("overlay-child"))
    expect(overlay.querySelectorAll('[data-slot="app-edge-fade"]')).toHaveLength(1)
    fireEvent.click(overlay)
    expect(clicked).toHaveBeenCalledOnce()
  })

  it("keeps an explicitly overlay-free Sheet without backdrop decoration", () => {
    render(<Sheet defaultOpen><SheetContent showOverlay={false}><SheetTitle>Profile</SheetTitle></SheetContent></Sheet>)
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
    expect(document.querySelector('[data-slot="app-edge-fade"]')).toBeNull()
  })
})
