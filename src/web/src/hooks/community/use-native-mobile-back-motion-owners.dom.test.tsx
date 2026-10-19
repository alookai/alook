import { useRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { hasNativeBackOwner, useNativeBackOwner } from "@/components/ui/native-back-layer"
import { NATIVE_MOBILE_BACK_EVENT, NATIVE_MOBILE_BACK_PROGRESS_EVENT, useNativeMobileBack } from "./use-native-mobile-back"

function Owner({ eligible, request }: { eligible: boolean; request: () => "blocked" }) {
  const ref = useRef<HTMLDivElement>(null)
  useNativeBackOwner(() => eligible ? ref.current : null, request)
  return <div ref={ref} />
}

function Fixture({ owner = false, editor = false, scope = "alice/detail", replace, close, request }: {
  owner?: boolean
  editor?: boolean
  scope?: string
  replace: (path: string) => void
  close: () => void
  request: () => "blocked"
}) {
  useNativeMobileBack({ mobile: true, gestureKey: scope, parentPath: "/c/me", replacePath: replace, dismissShellOverlay: () => false })
  return <><Owner eligible={editor} request={request} />{owner && <Dialog open onOpenChange={close}>
    <DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>Owned popup</DialogDescription></DialogContent>
  </Dialog>}</>
}

function touch(type: string, x: number) {
  const points = [{ identifier: 1, clientX: x, clientY: 100 }]
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : points }, changedTouches: { value: points } })
  act(() => { document.dispatchEvent(event) })
}
function progress(value: number | null, started = value === 0) {
  act(() => { window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: value, started } })) })
}
function back() {
  act(() => { window.dispatchEvent(new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })) })
}

function transition(root: HTMLElement) {
  const target = root.querySelector<HTMLElement>('[data-panel][id="main"]')!
  const event = new Event("transitionend", { bubbles: true })
  Object.defineProperty(event, "propertyName", { value: "transform" })
  act(() => { target.dispatchEvent(event) })
}

const roots: HTMLElement[] = []
function setup() {
  vi.useFakeTimers()
  const root = document.createElement("div")
  root.dataset.mobileBackSurface = "detail"
  Object.defineProperty(root, "clientWidth", { value: 390 })
  const foreground = document.createElement("div")
  foreground.dataset.panel = "true"
  foreground.id = "main"
  root.appendChild(foreground)
  document.body.appendChild(root)
  roots.push(root)
  const props = { replace: vi.fn(), close: vi.fn(), request: vi.fn(() => "blocked" as const) }
  const view = render(<Fixture {...props} />)
  return { root, props, view }
}

afterEach(() => { roots.splice(0).forEach((root) => root.remove()); vi.useRealTimers() })

describe("shared Back ownership during page motion", () => {
  it.each(["account", "resize", "pagehide"])("ignores old zero progress after %s invalidates the gesture", (reason) => {
    const { root, props, view } = setup()
    progress(0); progress(0.6)
    expect(root.dataset.mobileBackPhase).toBe("dragging")
    if (reason === "account") view.rerender(<Fixture {...props} scope="bob/detail" />)
    else act(() => { window.dispatchEvent(new Event(reason)) })
    progress(0, false); progress(0.7)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    back()
    act(() => { vi.advanceTimersByTime(300) })
    expect(props.replace).not.toHaveBeenCalled()
    progress(0); progress(0.7); back()
    act(() => { vi.advanceTimersByTime(300) })
    expect(props.replace).toHaveBeenCalledOnce()
    view.unmount()
  })

  it.each(["popup", "editor"])("reads %s ownership during progress without requesting dismissal", (kind) => {
    const { root, props, view } = setup()
    view.rerender(<Fixture {...props} owner={kind === "popup"} editor={kind === "editor"} />)
    expect(hasNativeBackOwner(document)).toBe(true)
    progress(0); progress(0.7)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.close).not.toHaveBeenCalled()
    expect(props.request).not.toHaveBeenCalled()
    back()
    expect(kind === "popup" ? props.close : props.request).toHaveBeenCalledOnce()
    expect(props.replace).not.toHaveBeenCalled()
    view.unmount()
  })

  it.each(["touch", "native"])("keeps the current popup's terminal Back after interrupting %s movement", (kind) => {
    const { root, props, view } = setup()
    if (kind === "touch") { touch("touchstart", 10); touch("touchmove", 200) }
    else { progress(0); progress(0.5) }
    expect(root.dataset.mobileBackPhase).toBe(kind === "touch" ? undefined : "dragging")
    view.rerender(<Fixture {...props} owner />)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.close).not.toHaveBeenCalled()
    if (kind === "touch") touch("touchend", 200)
    else back()
    act(() => { vi.advanceTimersByTime(300) })
    expect(props.close).toHaveBeenCalledOnce()
    expect(props.replace).not.toHaveBeenCalled()
    view.unmount()
  })

  it.each(["touch", "native", "settling"])("never revives %s page commit after a transient owner exits", (kind) => {
    const { root, props, view } = setup()
    if (kind === "native") { progress(0); progress(0.5) }
    else { touch("touchstart", 10); touch("touchmove", 200) }
    if (kind === "settling") touch("touchend", 200)
    view.rerender(<Fixture {...props} editor />)
    view.rerender(<Fixture {...props} />)
    expect(hasNativeBackOwner(document)).toBe(false)
    if (kind === "touch") touch("touchend", 200)
    if (kind === "native") back()
    act(() => { vi.advanceTimersByTime(300) })
    transition(root)
    expect(props.request).not.toHaveBeenCalled()
    expect(props.replace).not.toHaveBeenCalled()
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    back()
    act(() => { vi.advanceTimersByTime(200) })
    transition(root)
    expect(props.replace).toHaveBeenCalledExactlyOnceWith("/c/me")
    view.unmount()
  })

  it("does not use the settling timer to close a new real popup", () => {
    const { root, props, view } = setup()
    touch("touchstart", 10); touch("touchmove", 200); touch("touchend", 200)
    view.rerender(<Fixture {...props} owner />)
    act(() => { vi.advanceTimersByTime(300) })
    transition(root)
    expect(props.close).not.toHaveBeenCalled()
    expect(props.replace).not.toHaveBeenCalled()
    back()
    expect(props.close).toHaveBeenCalledOnce()
    view.unmount()
  })

  it("consumes the old account's terminal before the new scope's popup", () => {
    const { props, view } = setup()
    progress(0); progress(0.6)
    view.rerender(<Fixture {...props} scope="bob/detail" owner />)
    progress(0.8); back()
    expect(props.close).not.toHaveBeenCalled()
    expect(props.replace).not.toHaveBeenCalled()
    back()
    expect(props.close).toHaveBeenCalledOnce()
    view.unmount()
  })

  it("retires pagehide's settle and ignores old progress after BFCache return", () => {
    const { root, props, view } = setup()
    progress(0); progress(0.6)
    act(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })) })
    act(() => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })) })
    progress(0.9); back()
    act(() => { vi.advanceTimersByTime(300) })
    expect(props.replace).not.toHaveBeenCalled()
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    progress(0); progress(0.6); back()
    act(() => { vi.advanceTimersByTime(200) })
    expect(props.replace).toHaveBeenCalledExactlyOnceWith("/c/me")
    view.unmount()
  })
})
