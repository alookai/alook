import { createRequire } from "node:module"
import { createRef, StrictMode, useEffect, useState } from "react"
import { renderToString } from "react-dom/server"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { Drawer as EsmDrawer } from "@base-ui/react/drawer"
import { Dialog as EsmDialog } from "@base-ui/react/dialog"
import { fireEvent, render, setupUser, waitFor } from "@/test/react-dom-harness"
import type { CommunityNavigationController } from "@/contexts/community/route-frame"
import { CommunityMobileBackContext, CommunityMobileBackDrawer } from "./community-mobile-back-drawer"

const android = vi.hoisted(() => {
  const original = Object.getOwnPropertyDescriptor(navigator, "userAgent")
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Linux; Android 14) Chrome/156.0 Mobile" })
  return { original }
})
afterAll(() => {
  if (android.original) Object.defineProperty(navigator, "userAgent", android.original)
  else Reflect.deleteProperty(navigator, "userAgent")
})
afterEach(() => { vi.unstubAllGlobals() })
const require = createRequire(import.meta.url)
const variants = [
  { name: "ESM", Drawer: EsmDrawer, Dialog: EsmDialog },
  { name: "CJS", Drawer: require("@base-ui/react/drawer").Drawer as typeof EsmDrawer, Dialog: require("@base-ui/react/dialog").Dialog as typeof EsmDialog },
]

describe.each(variants)("public Drawer adaptation $name", ({ Drawer, Dialog }) => {
  it("hydrates one inline SSR business tree and retains public ref,render,attributes and events", () => {
    const host = createRef<HTMLDivElement>()
    const click = vi.fn()
    let mounts = 0
    function Business() {
      useEffect(() => { mounts++ }, [])
      return <input data-testid="business" defaultValue="SSR draft" />
    }
    const external = document.createElement("div")
    document.body.appendChild(external)
    const tree = (open = true) => <StrictMode><Drawer.Root open={open} closeWatcher={false} modal={false} disablePointerDismissal>
      <Drawer.Portal inline keepMounted container={external} ref={host} render={<section />} className="inline-host" data-fixture="public" style={{ color: "red" }} onClick={click}>
        <Drawer.Viewport><Drawer.Popup initialFocus={false} finalFocus={false}><Business /></Drawer.Popup></Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root></StrictMode>
    const container = document.createElement("div")
    container.innerHTML = renderToString(tree())
    document.body.appendChild(container)
    const original = container.querySelector("input")!
    original.value = "early input"; original.scrollTop = 47; original.focus()
    const view = render(tree(), { container, hydrate: true })
    expect(view.getByTestId("business")).toBe(original)
    expect(original.value).toBe("early input")
    expect(original.scrollTop).toBe(47)
    expect(document.activeElement).toBe(original)
    expect(host.current?.tagName).toBe("SECTION")
    expect(host.current).toHaveAttribute("data-fixture", "public")
    expect(host.current).toHaveClass("inline-host")
    expect(host.current).toHaveStyle({ color: "rgb(255, 0, 0)" })
    expect(external.childElementCount).toBe(0)
    const mounted = mounts
    fireEvent.click(original)
    expect(click).toHaveBeenCalledOnce()
    view.rerender(tree(false)); view.rerender(tree(true))
    expect(view.getByTestId("business")).toBe(original)
    expect(mounts).toBe(mounted)
    expect(view.getAllByTestId("business")).toHaveLength(1)
    external.remove()
  })

  it.each(["Dialog", "Drawer"] as const)("preserves the default %s portal and keepMounted path", (kind) => {
    const Parts = kind === "Drawer" ? Drawer : Dialog
    const target = document.createElement("div")
    document.body.appendChild(target)
    const portal = createRef<HTMLDivElement>()
    const tree = (open = true) => <Parts.Root open={open} modal={false} disablePointerDismissal>
      <Parts.Portal container={target} keepMounted ref={portal} data-default-portal>
        <Parts.Viewport><Parts.Popup initialFocus={false} finalFocus={false}><input data-testid="default-business" /></Parts.Popup></Parts.Viewport>
      </Parts.Portal>
    </Parts.Root>
    const view = render(tree())
    const business = target.querySelector("input")!
    expect(view.container.querySelector("input")).toBeNull()
    expect(target.contains(portal.current)).toBe(true)
    expect(portal.current).toHaveAttribute("data-default-portal")
    view.rerender(tree(false)); view.rerender(tree(true))
    expect(target.querySelector("input")).toBe(business)
    view.unmount(); target.remove()
  })

  it("preserves default focus,Escape and nested Dialog ownership", async () => {
    function Nested() {
      const [open, setOpen] = useState(false)
      return <Dialog.Root open={open} onOpenChange={setOpen}><Dialog.Trigger>Open nested</Dialog.Trigger>
        <Dialog.Portal><Dialog.Popup><Dialog.Title>Nested</Dialog.Title><Dialog.Description>Nested dialog</Dialog.Description><Dialog.Close>Close nested</Dialog.Close></Dialog.Popup></Dialog.Portal>
      </Dialog.Root>
    }
    const view = render(<Drawer.Root><Drawer.Trigger>Open drawer</Drawer.Trigger><Drawer.Portal><Drawer.Viewport>
      <Drawer.Popup><Drawer.Title>Outer</Drawer.Title><Drawer.Description>Default drawer</Drawer.Description><Nested /><Drawer.Close>Close drawer</Drawer.Close></Drawer.Popup>
    </Drawer.Viewport></Drawer.Portal></Drawer.Root>)
    const trigger = view.getByRole("button", { name: "Open drawer" })
    trigger.focus(); fireEvent.click(trigger)
    await waitFor(() => expect(view.getByRole("dialog", { name: "Outer" })).toContainElement(document.activeElement as HTMLElement))
    fireEvent.click(view.getByRole("button", { name: "Open nested" }))
    await waitFor(() => expect(view.getByRole("dialog", { name: "Nested" })).toBeInTheDocument())
    fireEvent.keyDown(view.getByRole("button", { name: "Close nested" }), { key: "Escape" })
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Nested" })).toBeNull())
    expect(view.getByRole("dialog", { name: "Outer" })).toBeInTheDocument()
    fireEvent.keyDown(view.getByRole("button", { name: "Close drawer" }), { key: "Escape" })
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Outer" })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it.each(["Dialog", "Drawer"] as const)("preserves default outside-press dismissal for nonmodal %s", async (kind) => {
    const Parts = kind === "Drawer" ? Drawer : Dialog
    function Example() {
      const [open, setOpen] = useState(true)
      return <><button data-testid="outside">Outside</button><Parts.Root open={open} onOpenChange={setOpen} modal={false}>
        <Parts.Portal><Parts.Viewport><Parts.Popup initialFocus={false} finalFocus={false}><Parts.Title>Dismissible</Parts.Title><Parts.Description>Outside press control</Parts.Description></Parts.Popup></Parts.Viewport></Parts.Portal>
      </Parts.Root></>
    }
    const view = render(<Example />)
    expect(view.getByRole("dialog", { name: "Dismissible" })).toBeInTheDocument()
    await setupUser().click(view.getByTestId("outside"))
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Dismissible" })).toBeNull())
  })

  it("keeps default Android watcher behavior and cleans up an explicit opt-out", () => {
    const instances: { destroy: ReturnType<typeof vi.fn> }[] = []
    class Watcher extends EventTarget {
      destroy = vi.fn()
      constructor() { super(); instances.push(this) }
    }
    vi.stubGlobal("CloseWatcher", Watcher)
    const tree = (enabled?: boolean) => <Drawer.Root open closeWatcher={enabled} modal={false}>
      <Drawer.Portal><Drawer.Viewport><Drawer.Popup initialFocus={false} finalFocus={false}>Default</Drawer.Popup></Drawer.Viewport></Drawer.Portal>
    </Drawer.Root>
    const view = render(tree())
    expect(instances.filter(instance => !instance.destroy.mock.calls.length)).toHaveLength(1)
    const created = instances.length
    view.rerender(tree(false))
    expect(instances.every(instance => instance.destroy.mock.calls.length === 1)).toBe(true)
    expect(instances).toHaveLength(created)
    view.rerender(tree(true))
    expect(instances.filter(instance => !instance.destroy.mock.calls.length)).toHaveLength(1)
    view.unmount()
    expect(instances.every(instance => instance.destroy.mock.calls.length === 1)).toBe(true)
  })
})

it.each([
  { name: "active", mobile: true, targetHref: "/c/me/dm1" },
  { name: "inactive list", mobile: true, targetHref: "/c/me" },
  { name: "desktop", mobile: false, targetHref: "/c/me/dm1" },
])("never creates a page Drawer watcher on $name", ({ mobile, targetHref }) => {
  const watcher = vi.fn(function () { return { destroy: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } })
  vi.stubGlobal("CloseWatcher", watcher)
  const navigation = { replace: vi.fn(), captureIntent: () => () => true } as unknown as CommunityNavigationController
  render(<CommunityMobileBackContext value={{ mobile, enabled: true, targetHref, frameKey: "fixture", parentHref: "/c/me", navigation, nativeInsets: null }}>
    <CommunityMobileBackDrawer level="list">Page</CommunityMobileBackDrawer>
  </CommunityMobileBackContext>)
  expect(watcher).not.toHaveBeenCalled()
})
