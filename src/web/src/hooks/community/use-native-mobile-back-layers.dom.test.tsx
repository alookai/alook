import { createRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { act, fireEvent, render, screen, setupUser, waitFor } from "@/test/react-dom-harness"
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { NATIVE_MOBILE_BACK_EVENT, useNativeMobileBack } from "./use-native-mobile-back"

function BackListener({ replacePath }: { replacePath: (path: string) => void }) {
  useNativeMobileBack({ dismissShellOverlay: () => false, parentPath: "/c/me", replacePath })
  return null
}

function back() {
  const event = new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })
  act(() => { window.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
}

function escapeAtFocus() {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape", code: "Escape", bubbles: true, cancelable: true,
    }))
  })
}

function Modal({ name, onClose, children }: {
  name: string
  onClose: () => void
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) onClose() }}>
      <DialogContent>
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>Test content</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  )
}

describe("native Back with real Base UI layers", () => {
  it("closes one modal without page navigation", async () => {
    const close = vi.fn()
    const replacePath = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Modal name="Single" onClose={close} /></>)
    await screen.findByRole("dialog", { name: "Single" })
    back()
    await waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("uses native nesting to close only the child modal", async () => {
    const parentClose = vi.fn()
    const childClose = vi.fn()
    const replacePath = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Modal name="Parent" onClose={parentClose}><Modal name="Child" onClose={childClose} /></Modal></>)
    await screen.findByRole("dialog", { name: "Child" })
    back()
    await waitFor(() => { expect(childClose).toHaveBeenCalledOnce() })
    expect(parentClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it.each(["native Back", "focused Escape"])("%s closes only the newly opened independent sibling modal", async (input) => {
    const parentClose = vi.fn()
    const childClose = vi.fn()
    const replacePath = vi.fn()
    function Siblings() {
      const [childOpen, setChildOpen] = useState(false)
      return <><Modal name="First" onClose={parentClose}><button onClick={() => setChildOpen(true)}>Open second</button></Modal>{childOpen && <Modal name="Second" onClose={childClose} />}</>
    }
    const user = setupUser()
    render(<><BackListener replacePath={replacePath} /><Siblings /></>)
    await user.click(await screen.findByRole("button", { name: "Open second" }))
    const second = await screen.findByRole("dialog", { name: "Second" })
    await waitFor(() => { expect(second.contains(document.activeElement)).toBe(true) })
    if (input === "native Back") back()
    else escapeAtFocus()
    await waitFor(() => { expect(childClose).toHaveBeenCalledOnce() })
    expect(parentClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it.each(["native Back", "focused Escape"])("%s closes a standalone popover before page navigation", async (input) => {
    const close = vi.fn()
    const replacePath = vi.fn()
    function StandalonePopover() {
      const [open, setOpen] = useState(false)
      return <Popover open={open} onOpenChange={(value) => { setOpen(value); if (!value) close() }}><PopoverTrigger>Open popover</PopoverTrigger><PopoverContent><PopoverTitle>Popover content</PopoverTitle></PopoverContent></Popover>
    }
    const user = setupUser()
    render(<><BackListener replacePath={replacePath} /><StandalonePopover /></>)
    await user.click(screen.getByRole("button", { name: "Open popover" }))
    const popup = await screen.findByRole("dialog", { name: "Popover content" })
    await waitFor(() => { expect(popup.contains(document.activeElement)).toBe(true) })
    if (input === "native Back") back()
    else escapeAtFocus()
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it.each(["menu", "select"])("closes standalone %s before page navigation", async (kind) => {
    const close = vi.fn()
    const replacePath = vi.fn()
    const user = setupUser()
    function Popup() {
      const [open, setOpen] = useState(false)
      const onOpenChange = (value: boolean) => { setOpen(value); if (!value) close() }
      return kind === "menu"
        ? <DropdownMenu open={open} onOpenChange={onOpenChange}><DropdownMenuTrigger>Open choices</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Choice</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        : <Select open={open} onOpenChange={onOpenChange}><SelectTrigger aria-label="Open choices"><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent><SelectItem value="one">Choice</SelectItem></SelectContent></Select>
    }
    render(<><BackListener replacePath={replacePath} /><Popup /></>)
    await user.click(screen.getByRole(kind === "menu" ? "button" : "combobox", { name: "Open choices" }))
    await screen.findByRole(kind === "menu" ? "menuitem" : "option", { name: "Choice" })
    back()
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("keeps a controlled locked owner without navigating beneath it", async () => {
    const replacePath = vi.fn()
    const attemptedClose = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Dialog open onOpenChange={attemptedClose}><DialogContent showCloseButton={false}><DialogTitle>Locked</DialogTitle><DialogDescription>Test content</DialogDescription></DialogContent></Dialog></>)
    await screen.findByRole("dialog", { name: "Locked" })
    back()
    expect(attemptedClose).toHaveBeenCalledOnce()
    expect(screen.getByRole("dialog", { name: "Locked" })).toBeVisible()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("keeps ownership through an externally held closing phase", async () => {
    const replacePath = vi.fn()
    const parentClose = vi.fn()
    const close = vi.fn()
    const actions = createRef<{ close: () => void; unmount: () => void }>()
    function ClosingChild() {
      const [open, setOpen] = useState(true)
      return <Dialog open={open} actionsRef={actions} onOpenChange={(value, details) => { if (!value) { details.preventUnmountOnClose(); close() }; setOpen(value) }}><DialogContent><DialogTitle>Closing child</DialogTitle><DialogDescription>Test content</DialogDescription></DialogContent></Dialog>
    }
    render(<><BackListener replacePath={replacePath} /><Modal name="Parent" onClose={parentClose}><ClosingChild /></Modal></>)
    const child = await screen.findByRole("dialog", { name: "Closing child" })
    await waitFor(() => { expect(child.contains(document.activeElement)).toBe(true) })
    back()
    expect(close).toHaveBeenCalledOnce()
    back()
    expect(parentClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
    act(() => { actions.current?.unmount() })
    back()
    expect(parentClose).toHaveBeenCalledOnce()
  })

  it("selects the nested child when its independent branch mounts after another modal", async () => {
    const replacePath = vi.fn()
    const otherClose = vi.fn(), parentClose = vi.fn(), childClose = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Modal name="Other" onClose={otherClose} /><Modal name="Branch" onClose={parentClose}><Modal name="Branch child" onClose={childClose} /></Modal></>)
    await screen.findByText("Branch child")
    back()
    expect(childClose).toHaveBeenCalledOnce()
    expect(parentClose).not.toHaveBeenCalled()
    expect(otherClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("releases a closed keepMounted popup and registers each reopen", async () => {
    const replacePath = vi.fn()
    const completed = vi.fn()
    const user = setupUser()
    render(<><BackListener replacePath={replacePath} /><Popover onOpenChangeComplete={completed}><PopoverTrigger>Open kept popup</PopoverTrigger><PopoverPortal keepMounted><PopoverPositioner><PopoverPopup><PopoverTitle>Kept popup</PopoverTitle></PopoverPopup></PopoverPositioner></PopoverPortal></Popover></>)
    for (let index = 0; index < 2; index++) {
      await user.click(screen.getByRole("button", { name: "Open kept popup" }))
      await screen.findByRole("dialog", { name: "Kept popup" })
      back()
      await waitFor(() => { expect(completed.mock.calls.filter(([open]) => !open)).toHaveLength(index + 1) })
      expect(document.querySelector('[data-slot="popover-content"]')).toBeTruthy()
      expect(screen.queryByRole("dialog", { name: "Kept popup" })).toBeNull()
      back()
      expect(replacePath).toHaveBeenCalledTimes(index + 1)
    }
  })

  it("retains detached handle triggers and the original render function", async () => {
    const handle = DialogPrimitive.createHandle()
    const replacePath = vi.fn(), close = vi.fn()
    const user = setupUser()
    const ref = createRef<HTMLDivElement>()
    render(<><BackListener replacePath={replacePath} /><DialogTrigger handle={handle}>Open detached</DialogTrigger><Dialog handle={handle} onOpenChange={(open) => { if (!open) close() }}><DialogContent ref={ref} render={(props, state) => <section {...props} data-render-open={state.open} />}><DialogTitle>Detached</DialogTitle><DialogDescription>Test content</DialogDescription></DialogContent></Dialog></>)
    for (let index = 0; index < 2; index++) {
      await user.click(screen.getByRole("button", { name: "Open detached" }))
      const popup = await screen.findByRole("dialog", { name: "Detached" })
      expect(popup.tagName).toBe("SECTION")
      expect(popup).toHaveAttribute("data-render-open", "true")
      expect(ref.current).toBe(popup)
      back()
      expect(close).toHaveBeenCalledTimes(index + 1)
      await waitFor(() => { expect(screen.queryByRole("dialog", { name: "Detached" })).toBeNull() })
    }
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("gives a cancel-owned unsaved confirmation its own next Back", async () => {
    const replacePath = vi.fn(), attempts = vi.fn(), confirmClose = vi.fn()
    function Unsaved() {
      const [confirm, setConfirm] = useState(false)
      return <><Dialog open onOpenChange={(open, details) => { if (!open) { attempts(); details.cancel(); setConfirm(true) } }}><DialogContent><DialogTitle>Unsaved form</DialogTitle><DialogDescription>Test content</DialogDescription></DialogContent></Dialog><AlertDialog open={confirm} onOpenChange={(open) => { setConfirm(open); if (!open) confirmClose() }}><AlertDialogContent><AlertDialogTitle>Discard changes?</AlertDialogTitle><AlertDialogDescription>Test content</AlertDialogDescription><AlertDialogCancel>Keep editing</AlertDialogCancel></AlertDialogContent></AlertDialog></>
    }
    render(<><BackListener replacePath={replacePath} /><Unsaved /></>)
    await screen.findByRole("dialog", { name: "Unsaved form" })
    back()
    const confirmation = await screen.findByRole("alertdialog", { name: "Discard changes?" })
    await waitFor(() => { expect(confirmation.contains(document.activeElement)).toBe(true) })
    expect(attempts).toHaveBeenCalledOnce()
    back()
    expect(confirmClose).toHaveBeenCalledOnce()
    expect(attempts).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("keeps a composing modal input, then uses the same native close callback", async () => {
    const replacePath = vi.fn(), close = vi.fn()
    render(<><BackListener replacePath={replacePath} /><Modal name="Composing" onClose={close}><input aria-label="Test input" /></Modal></>)
    const input = await screen.findByRole("textbox", { name: "Test input" })
    act(() => { input.focus(); fireEvent.compositionStart(input) })
    back()
    expect(close).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.compositionEnd(input)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    back()
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it.each(["popover", "menu", "select", "context menu"])("gives a nested %s one Back before its modal", async (kind) => {
    const replacePath = vi.fn(), parentClose = vi.fn(), close = vi.fn()
    function Popup() {
      const [open, setOpen] = useState(false)
      const change = (value: boolean) => { setOpen(value); if (!value) close() }
      if (kind === "popover") return <Popover open={open} onOpenChange={change}><PopoverTrigger>Open nested</PopoverTrigger><PopoverContent><PopoverTitle>Nested choices</PopoverTitle></PopoverContent></Popover>
      if (kind === "menu") return <DropdownMenu open={open} onOpenChange={change}><DropdownMenuTrigger>Open nested</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>Nested choice</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      if (kind === "select") return <Select open={open} onOpenChange={change}><SelectTrigger aria-label="Open nested"><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent><SelectItem value="one">Nested choice</SelectItem></SelectContent></Select>
      return <ContextMenu open={open} onOpenChange={change}><ContextMenuTrigger>Open nested</ContextMenuTrigger><ContextMenuContent><ContextMenuItem>Nested choice</ContextMenuItem></ContextMenuContent></ContextMenu>
    }
    render(<><BackListener replacePath={replacePath} /><Modal name="Modal behind popup" onClose={parentClose}><Popup /></Modal></>)
    const trigger = kind === "select"
      ? await screen.findByRole("combobox", { name: "Open nested" })
      : await screen.findByText("Open nested")
    if (kind === "context menu") fireEvent.contextMenu(trigger, { button: 2, clientX: 20, clientY: 30 })
    else await setupUser().click(trigger)
    await screen.findByRole(kind === "popover" ? "dialog" : kind === "select" ? "option" : "menuitem", {
      name: kind === "popover" ? "Nested choices" : "Nested choice",
    })
    back()
    expect(close).toHaveBeenCalledOnce()
    expect(parentClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("uses the open popup owner when focus stays outside it", async () => {
    const replacePath = vi.fn(), close = vi.fn()
    function Popup() {
      const [open, setOpen] = useState(false)
      return <Popover open={open} onOpenChange={(value, details) => {
        if (details.reason === "focus-out") { details.cancel(); return }
        setOpen(value)
        if (!value) close()
      }}><PopoverTrigger>Open without focus</PopoverTrigger><PopoverContent initialFocus={false}><PopoverTitle>Unfocused popup</PopoverTitle></PopoverContent></Popover>
    }
    render(<><BackListener replacePath={replacePath} /><input aria-label="Outside" /><Popup /></>)
    await setupUser().click(screen.getByRole("button", { name: "Open without focus" }))
    await screen.findByRole("dialog", { name: "Unfocused popup" })
    act(() => { screen.getByRole("textbox", { name: "Outside" }).focus() })
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Outside" }))
    back()
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("releases an unmounted root before registering a fresh instance", async () => {
    const replacePath = vi.fn(), close = vi.fn()
    const listener = <BackListener replacePath={replacePath} />
    const view = render(<>{listener}<Modal name="Retiring" onClose={close} /></>)
    await screen.findByRole("dialog", { name: "Retiring" })
    view.rerender(listener)
    back()
    expect(replacePath).toHaveBeenCalledOnce()
    view.rerender(<>{listener}<Modal name="Fresh" onClose={close} /></>)
    await screen.findByRole("dialog", { name: "Fresh" })
    back()
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).toHaveBeenCalledOnce()
  })

  it("closes a native submenu before the root menu", async () => {
    const replacePath = vi.fn(), parentClose = vi.fn(), childClose = vi.fn()
    render(<><BackListener replacePath={replacePath} /><DropdownMenu defaultOpen onOpenChange={(open) => { if (!open) parentClose() }}><DropdownMenuTrigger>Parent menu</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuSub defaultOpen onOpenChange={(open) => { if (!open) childClose() }}><DropdownMenuSubTrigger>Submenu</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuItem>Child item</DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub></DropdownMenuContent></DropdownMenu></>)
    await screen.findByRole("menuitem", { name: "Child item" })
    back()
    expect(childClose).toHaveBeenCalledOnce()
    expect(parentClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("keeps ownership when a custom render replaces its DOM element", async () => {
    const replacePath = vi.fn(), close = vi.fn()
    function CustomPopup() {
      const [section, setSection] = useState(false)
      return <Dialog defaultOpen onOpenChange={(open) => { if (!open) close() }}><DialogContent render={section ? <section /> : <article />}><DialogTitle>Custom node</DialogTitle><DialogDescription>Test content</DialogDescription><button onClick={() => setSection(true)}>Replace node</button></DialogContent></Dialog>
    }
    render(<><BackListener replacePath={replacePath} /><CustomPopup /></>)
    const first = await screen.findByRole("dialog", { name: "Custom node" })
    expect(first.tagName).toBe("ARTICLE")
    await setupUser().click(screen.getByRole("button", { name: "Replace node" }))
    const second = await screen.findByRole("dialog", { name: "Custom node" })
    expect(second.tagName).toBe("SECTION")
    expect(first.isConnected).toBe(false)
    back()
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
  })

  it("holds the same closing owner when custom render replaces the DOM on close", async () => {
    const replacePath = vi.fn(), parentClose = vi.fn(), childClose = vi.fn()
    const actions = createRef<{ close: () => void; unmount: () => void }>()
    function ClosingPopup() {
      const [open, setOpen] = useState(true)
      return <Dialog open={open} actionsRef={actions} onOpenChange={(value, details) => {
        if (!value) { details.preventUnmountOnClose(); childClose() }
        setOpen(value)
      }}><DialogContent render={(props, state) => state.open ? <article {...props} /> : <section {...props} data-closing-replacement="true" />}><DialogTitle>Changing closing node</DialogTitle><DialogDescription>Test content</DialogDescription></DialogContent></Dialog>
    }
    render(<><BackListener replacePath={replacePath} /><Modal name="Parent with closing child" onClose={parentClose}><ClosingPopup /></Modal></>)
    const first = await screen.findByRole("dialog", { name: "Changing closing node" })
    back()
    expect(childClose).toHaveBeenCalledOnce()
    expect(first.isConnected).toBe(false)
    expect(document.querySelector('[data-closing-replacement="true"]')).toBeTruthy()
    back()
    expect(parentClose).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
    act(() => { actions.current?.unmount() })
    back()
    expect(parentClose).toHaveBeenCalledOnce()
  })
})
