"use client"

import * as React from "react"
import { Drawer } from "@base-ui/react/drawer"
import { useRender } from "@base-ui/react/use-render"
import { useIsMobile } from "@/hooks/use-mobile"
import { useConversationActivity } from "@/contexts/community/conversation-activity"
import { cn } from "@/lib/utils"
import { NativeBackRoot, useNativeBackPopupRender, useNativeBackRoot } from "./native-back-layer"
import { canStartSwipe, isSystemSwipeStart } from "./swipe-gesture-policy"
import styles from "./swipe-container.module.css"

type SwipeKind = "page" | "overlay"
const SwipeContext = React.createContext({ enabled: false, active: true, kind: "overlay" as SwipeKind, cancelledRef: { current: false } })

export type SwipeRootProps = Drawer.Root.Props & {
  kind?: SwipeKind
  swipeEnabled?: boolean
}

export function SwipeRoot({
  kind = "overlay", swipeEnabled = true, swipeDirection = "right",
  onOpenChange, onOpenChangeComplete, ...props
}: SwipeRootProps) {
  const mobile = useIsMobile()
  const conversationActive = useConversationActivity()
  const active = kind === "page" || conversationActive
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(props.defaultOpen ?? false)
  const cancelledRef = React.useRef(false)
  const back = useNativeBackRoot(onOpenChangeComplete)
  const root = <SwipeContext value={{ enabled: mobile && swipeEnabled && active, active, kind, cancelledRef }}>
    <Drawer.Root {...props} swipeDirection={swipeDirection}
      open={active && (props.open ?? uncontrolledOpen)}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "swipe" && (cancelledRef.current || details.event.type.endsWith("cancel"))) {
          details.cancel()
          return
        }
        onOpenChange?.(next, details)
        if (!details.isCanceled && props.open === undefined) setUncontrolledOpen(next)
      }}
      {...(kind === "page" ? { modal: false, disablePointerDismissal: true } : {})}
      onOpenChangeComplete={kind === "page" ? onOpenChangeComplete : back.complete} />
  </SwipeContext>
  return kind === "overlay" ? <NativeBackRoot value={back.owner}>{root}</NativeBackRoot> : root
}

const SwipeViewportElement = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(function SwipeViewportElement({
  onPointerDown, onPointerMove, onPointerUp, onPointerCancel,
  onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onClick, onContextMenu, ...props
}, ref) {
  const { enabled, kind, cancelledRef } = React.useContext(SwipeContext)
  const isolate = kind === "overlay" || enabled
  return <div {...props} ref={ref} data-swipe-viewport={kind}
    onPointerDown={(event) => {
      cancelledRef.current = !canStartSwipe({ target: event.target, x: event.clientX, y: event.clientY, root: event.currentTarget,
        enabled, kind, pointerType: event.pointerType })
      if (!cancelledRef.current) onPointerDown?.(event)
      if (isolate) event.stopPropagation()
    }}
    onTouchStart={(event) => {
      const touch = event.touches[0]
      cancelledRef.current = !touch || !canStartSwipe({ target: event.target, x: touch.clientX, y: touch.clientY, root: event.currentTarget,
        enabled, kind, pointerType: "touch", touches: event.touches.length })
      if (cancelledRef.current) onTouchCancel?.(event)
      else onTouchStart?.(event)
      if (isolate) event.stopPropagation()
    }}
    onPointerMove={(event) => { onPointerMove?.(event); if (isolate) event.stopPropagation() }}
    onPointerUp={(event) => { onPointerUp?.(event); if (isolate) event.stopPropagation() }}
    onPointerCancel={(event) => { onPointerCancel?.(event); if (isolate) event.stopPropagation() }}
    onTouchMove={(event) => {
      const selection = event.currentTarget.ownerDocument.getSelection()
      if ((event.touches.length > 1 || selection && !selection.isCollapsed) && !cancelledRef.current) {
        cancelledRef.current = true
        onTouchCancel?.(event)
      } else if (!cancelledRef.current) onTouchMove?.(event)
      if (isolate) event.stopPropagation()
    }}
    onTouchEnd={(event) => { onTouchEnd?.(event); if (isolate) event.stopPropagation() }}
    onTouchCancel={(event) => { onTouchCancel?.(event); if (isolate) event.stopPropagation() }}
    onClick={(event) => { onClick?.(event); if (kind === "overlay") event.stopPropagation() }}
    onContextMenu={(event) => { onContextMenu?.(event); if (kind === "overlay") event.stopPropagation() }} />
})

export function usePageSwipeStart() {
  const { enabled, kind } = React.useContext(SwipeContext)
  const page = enabled && kind === "page"
  const reservesReply = React.useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (!page || !(event.target instanceof Element)) return false
    const root = event.target.closest<HTMLElement>('[data-swipe-viewport="page"]')
    return !!root && (isSystemSwipeStart(root, event.clientX) || canStartSwipe({ target: event.target, root, x: event.clientX, y: event.clientY,
      enabled: true, kind: "page", pointerType: event.pointerType }))
  }, [page])
  return { page, reservesReply }
}

export function SwipeViewport({ className, ...props }: Omit<Drawer.Viewport.Props, "render">) {
  return <Drawer.Viewport {...props} className={cn(styles.viewport, className)} render={<SwipeViewportElement />} />
}

function SwipePopupElement({ elementProps, state, render }: {
  elementProps: React.ComponentPropsWithRef<"div">
  state: Drawer.Popup.State
  render: Drawer.Popup.Props["render"]
}) {
  return useRender<Drawer.Popup.State & Record<string, unknown>, HTMLDivElement>({ render, state: { ...state }, props: { ...elementProps, inert: !state.open || elementProps.inert }, ref: elementProps.ref })
}

export function SwipePopup({ className, render, ...props }: Drawer.Popup.Props) {
  const { kind, active } = React.useContext(SwipeContext)
  const inertRender = React.useCallback((elementProps: React.ComponentPropsWithRef<"div">, state: Drawer.Popup.State) => (
    <SwipePopupElement elementProps={elementProps} state={state} render={render} />
  ), [render])
  const popupRender = useNativeBackPopupRender<Drawer.Popup.State>(inertRender)
  return <Drawer.Popup {...props} className={cn(styles.popup, className)}
    {...(!active ? { hidden: true } : {})}
    {...(kind === "page" ? { role: "presentation", initialFocus: false, finalFocus: false } : {})}
    render={kind === "page" ? inertRender : popupRender} />
}

export function SwipeBackdrop({ className, ...props }: Drawer.Backdrop.Props) {
  const { active } = React.useContext(SwipeContext)
  return <Drawer.Backdrop {...props} {...(!active ? { hidden: true } : {})} className={cn(styles.backdrop, className)} />
}

export const SwipePortal = Drawer.Portal
export const SwipeTrigger = Drawer.Trigger
export const SwipeClose = Drawer.Close
export const SwipeTitle = Drawer.Title
export const SwipeDescription = Drawer.Description
