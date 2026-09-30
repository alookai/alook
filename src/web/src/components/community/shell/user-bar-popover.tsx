"use client"

import type { ReactNode, RefObject } from "react"
import { Popover, PopoverPortal, PopoverPositioner, PopoverPopup } from "@/components/ui/popover"
import { tid } from "@/lib/community/testids"
import { useProfileSecondaryPosition } from "@/components/community/social/profile-secondary-position"

export function UserBarPopover({ anchor, children, companion, onDismiss, onEscape }: {
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
  companion?: ReactNode
  onDismiss: () => void
  onEscape: () => void
}) {
  const {
    popoverRef,
    cardRef,
    previewRef,
    position,
    ready,
  } = useProfileSecondaryPosition(Boolean(companion), "user-bar-profile", 0, 0)

  return (
    <Popover open onOpenChange={(open, details) => {
      if (open) return
      const target = details.event instanceof FocusEvent
        ? details.event.relatedTarget
        : details.event.target
      if (target instanceof Element && target.closest(`[data-testid="${tid.userBar}"]`)) {
        details.cancel()
        return
      }
      if (details.reason === "escape-key") onEscape()
      else onDismiss()
    }}>
      <PopoverPortal>
        <PopoverPositioner anchor={anchor} side="top" align="start" sideOffset={8}>
          <PopoverPopup
            ref={popoverRef}
            role="presentation"
            className={`relative w-80 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none ${companion && !ready ? "overflow-hidden" : "overflow-visible"}`}
            initialFocus={() => document.getElementById("community-user-bar-extension")}
            finalFocus={false}
          >
            <div ref={cardRef}>{children}</div>
            {companion && (
              <div
                ref={previewRef}
                data-testid={tid.userBarProfileSecondaryDock}
                data-placement={position?.placement}
                data-measurement-ready={ready ? "true" : "false"}
                aria-hidden={!ready}
                className="absolute w-full"
                style={{
                  left: position?.left ?? 0,
                  top: position?.top ?? 0,
                  height: position?.height,
                  visibility: ready ? "visible" : "hidden",
                  pointerEvents: ready ? undefined : "none",
                }}
              >
                {companion}
              </div>
            )}
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  )
}
