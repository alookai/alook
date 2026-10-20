"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement } from "react"
import { SwipeRoot, SwipePortal, SwipeViewport, SwipePopup } from "@/components/ui/swipe-container"
import { tid } from "@/lib/community/testids"
import type { UserBarExtensionKind } from "./user-bar-extension-state"

type Content = ReactElement<{ active?: UserBarExtensionKind; interactive?: boolean; animate?: boolean; focusOnOpen?: boolean; onInitialFocus?: () => void }>

function focusPanel(host: HTMLDivElement | null, content: Content) {
  const panel = host?.querySelector<HTMLElement>(`[data-testid="${tid.userBarExtension}"]`)
  if (!panel) return
  panel.focus({ preventScroll: true })
  content.props.onInitialFocus?.()
}

export function UserBarExtensionDrawer({ children, onDismiss }: { children: Content | null; onDismiss: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [retained, setRetained] = useAtom(useCreateAtom(children))
  const committedActive = useRef(children?.props.active)
  useLayoutEffect(() => {
    if (children) setRetained(children)
  }, [children, setRetained])
  useLayoutEffect(() => {
    const previous = committedActive.current
    const active = children?.props.active
    committedActive.current = active
    if (!children || previous === undefined || active === undefined || previous === active || !children.props.focusOnOpen) return
    focusPanel(host, children)
  }, [children, host])
  const open = children !== null
  const content = children ?? retained

  return (
    <div ref={setHost} className="community-user-bar-drawer-viewport">
      <SwipeRoot open={open} swipeDirection="down" modal={false} disablePointerDismissal
        onOpenChange={(next) => { if (!next) onDismiss() }}
        onOpenChangeComplete={(next) => { if (!next) setRetained(null) }}>
        <SwipePortal container={host} keepMounted>
          <SwipeViewport>
            <SwipePopup role="presentation" initialFocus={() => {
              if (children?.props.focusOnOpen) focusPanel(host, children)
              return false
            }} finalFocus={false}
              data-slot="user-bar-swipe" className="community-user-bar-drawer" inert={!open}>
              {content && cloneElement(content, { interactive: open, animate: false, focusOnOpen: false })}
            </SwipePopup>
          </SwipeViewport>
        </SwipePortal>
      </SwipeRoot>
    </div>
  )
}
