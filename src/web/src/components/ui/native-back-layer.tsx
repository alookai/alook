"use client"

import * as React from "react"
import { useRender } from "@base-ui/react/use-render"

type BackResult = "requested" | "blocked" | "none"
type BackOwner = {
  parent: BackOwner | null
}
type Registration = {
  owner: BackOwner
  element: HTMLElement
  phase: "open" | "closing"
  order: number
  request: () => BackResult
  eligible: () => boolean
}

const NativeBackContext = React.createContext<BackOwner | null>(null)
const owners = new WeakMap<Document, Set<Registration>>()
const registrations = new WeakMap<BackOwner, Registration>()
let order = 0

function release(owner: BackOwner, element?: HTMLElement) {
  const current = registrations.get(owner)
  if (!current || (element && current.element !== element)) return
  owners.get(current.element.ownerDocument)?.delete(current)
  registrations.delete(owner)
}

function activate(owner: BackOwner, element: HTMLElement, request: () => BackResult, eligible = () => true) {
  const current = registrations.get(owner)
  if (current?.element === element && current.phase === "open") {
    current.request = request
    current.eligible = eligible
    return
  }
  release(owner)
  const registration: Registration = { owner, element, phase: "open", order: ++order, request, eligible }
  registrations.set(owner, registration)
  let active = owners.get(element.ownerDocument)
  if (!active) {
    active = new Set()
    owners.set(element.ownerDocument, active)
  }
  active.add(registration)
}

function startClosing(owner: BackOwner, element: HTMLElement) {
  const current = registrations.get(owner)
  if (!current) return
  if (current.element.ownerDocument !== element.ownerDocument) {
    owners.get(current.element.ownerDocument)?.delete(current)
    let active = owners.get(element.ownerDocument)
    if (!active) {
      active = new Set()
      owners.set(element.ownerDocument, active)
    }
    active.add(current)
  }
  current.element = element
  current.phase = "closing"
}

function isDescendant(owner: BackOwner, parent: BackOwner) {
  for (let current = owner.parent; current; current = current.parent) {
    if (current === parent) return true
  }
  return false
}

function topNativeBackOwner(document: Document) {
  const active = Array.from(owners.get(document) ?? []).filter((current) => (
    current.element.isConnected && current.eligible()
  ))
  let top: Registration | null = null
  let topOrder = -1
  for (const current of active) {
    if (active.some((other) => isDescendant(other.owner, current.owner))) continue
    let branchOrder = current.order
    for (let parent = current.owner.parent; parent; parent = parent.parent) {
      branchOrder = Math.max(branchOrder, registrations.get(parent)?.order ?? 0)
    }
    if (branchOrder > topOrder || (branchOrder === topOrder && current.order > (top?.order ?? -1))) {
      top = current
      topOrder = branchOrder
    }
  }
  return top
}

export function requestNativeBack(document: Document): BackResult {
  const top = topNativeBackOwner(document)
  if (!top) return "none"
  if (top.phase === "closing") return "blocked"
  const result = top.request()
  if (result !== "none") return result
  release(top.owner)
  return requestNativeBack(document)
}

function requestEscape(element: HTMLElement): BackResult {
  const focused = element.ownerDocument.activeElement
  const target = focused && element.contains(focused) ? focused : element
  const event = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented ? "requested" : "blocked"
}

export function useNativeBackRoot(onOpenChangeComplete?: (open: boolean) => void) {
  const parent = React.useContext(NativeBackContext)
  const owner = React.useMemo<BackOwner>(() => ({ parent }), [parent])
  React.useLayoutEffect(() => () => { release(owner) }, [owner])
  const complete = React.useCallback((open: boolean) => {
    if (!open && registrations.get(owner)?.phase === "closing") release(owner)
    onOpenChangeComplete?.(open)
  }, [owner, onOpenChangeComplete])
  return { owner, complete }
}

export const NativeBackRoot = NativeBackContext.Provider

function NativeBackPopup<State extends { open: boolean }>({ elementProps, state, render }: {
  elementProps: React.ComponentPropsWithRef<"div">
  state: State
  render: useRender.RenderProp<State> | undefined
}) {
  const owner = React.useContext(NativeBackContext)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!owner || !element) return
    if (state.open) activate(owner, element, () => requestEscape(element))
    else startClosing(owner, element)
  })
  React.useLayoutEffect(() => {
    return () => { if (owner) release(owner) }
  }, [owner])
  return useRender({
    render,
    state,
    props: { ...elementProps },
    ref: [ref, elementProps.ref ?? null],
  })
}

export function useNativeBackPopupRender<State extends { open: boolean }>(render?: useRender.RenderProp<State>) {
  return React.useCallback((elementProps: React.ComponentPropsWithRef<"div">, state: State) => (
    <NativeBackPopup elementProps={elementProps} state={state} render={render} />
  ), [render])
}

export function useNativeBackOwner(getElement: () => HTMLElement | null, request: () => BackResult) {
  const { owner } = useNativeBackRoot()
  const refresh = React.useCallback(() => {
    const element = getElement()
    if (!element) {
      release(owner)
      return
    }
    activate(owner, element, request, () => getElement() === element)
  }, [getElement, owner, request])
  React.useLayoutEffect(() => { refresh() })
  return refresh
}
