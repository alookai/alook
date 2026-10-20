"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { cloneElement, useLayoutEffect, useState, type ReactElement } from "react"
import { SwipeRoot, SwipePortal, SwipeViewport, SwipePopup } from "@/components/ui/swipe-container"
import { tid } from "@/lib/community/testids"

type Content = ReactElement<{ interactive?: boolean; animate?: boolean; focusOnOpen?: boolean; onInitialFocus?: () => void }>

export function UserBarExtensionDrawer({ children, onDismiss }: { children: Content | null; onDismiss: () => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [retained, setRetained] = useAtom(useCreateAtom(children))
  useLayoutEffect(() => {
    if (children) setRetained(children)
  }, [children, setRetained])
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
              if (!children?.props.focusOnOpen) return false
              children.props.onInitialFocus?.()
              return host?.querySelector<HTMLElement>(`[data-testid="${tid.userBarExtension}"]`) ?? false
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
