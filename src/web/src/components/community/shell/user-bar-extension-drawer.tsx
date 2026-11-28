"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement } from "react"
import { SwipeRoot, SwipePortal, SwipeViewport, SwipePopup } from "@/components/ui/swipe-container"
import { useNativeKeyboard } from "@/hooks/use-native-keyboard"
import { tid } from "@/lib/community/testids"
import { COMMUNITY_USER_BAR_HEIGHT_CSS } from "./shell-frame-geometry"
import type { UserBarExtensionKind } from "./user-bar-extension-state"

type Content = ReactElement<{ active?: UserBarExtensionKind; interactive?: boolean; animate?: boolean; focusOnOpen?: boolean; onInitialFocus?: () => void }>

function focusPanel(host: HTMLDivElement | null, content: Content) {
  const panel = host?.querySelector<HTMLElement>(`[data-testid="${tid.userBarExtension}"]`)
  if (!panel) return
  panel.focus({ preventScroll: true })
  content.props.onInitialFocus?.()
}

export function UserBarExtensionDrawer({
  children,
  onDismiss,
  userBarHeightCss = COMMUNITY_USER_BAR_HEIGHT_CSS,
}: {
  children: Content | null
  onDismiss: () => void
  userBarHeightCss?: string
}) {
  const keyboard = useNativeKeyboard()
  const overlayGpuKeyboard = keyboard?.mode === "overlay-gpu"
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
  const gpuLayerActive = overlayGpuKeyboard && (open || content !== null)

  return (
    <div
      ref={setHost}
      data-alook-kb-gpu-layer={gpuLayerActive ? "true" : undefined}
      data-alook-kb-gpu-offset={gpuLayerActive ? "user-bar" : undefined}
      className={`community-user-bar-drawer-viewport${gpuLayerActive ? " alook-kb-gpu-layer" : ""}`}
      style={gpuLayerActive
        ? {
            ["--alook-kb-layer-translate-y" as string]: `calc(max(0px, calc(var(--alook-kb-layout-progress, 0px) - ${userBarHeightCss})) - max(0px, calc(var(--alook-kb-visual-progress, 0px) - ${userBarHeightCss})))`,
          }
        : undefined}
    >
      <SwipeRoot open={open} swipeDirection="down" modal={false} disablePointerDismissal
        onOpenChange={(next) => { if (!next) onDismiss() }}
        onOpenChangeComplete={(next) => { if (!next) setRetained(null) }}>
        <SwipePortal container={host} keepMounted>
          <SwipeViewport>
            <SwipePopup role="presentation" initialFocus={() => {
              if (children?.props.focusOnOpen) focusPanel(host, children)
              return false
            }} finalFocus={false}
              data-slot="user-bar-swipe" className="community-user-bar-drawer" style={{ marginBottom: `max(0px, calc(var(--alook-keyboard-progress, 0px) - ${userBarHeightCss}))` }} inert={!open}>
              {content && cloneElement(content, { interactive: open, animate: false, focusOnOpen: false })}
            </SwipePopup>
          </SwipeViewport>
        </SwipePortal>
      </SwipeRoot>
    </div>
  )
}
