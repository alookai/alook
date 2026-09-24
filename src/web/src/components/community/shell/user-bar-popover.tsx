"use client"

import type { ReactNode, RefObject } from "react"
import { Popover, PopoverPortal, PopoverPositioner, PopoverPopup } from "@/components/ui/popover"
import { tid } from "@/lib/community/testids"

export function UserBarPopover({ anchor, children, onDismiss, onEscape }: {
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
  onDismiss: () => void
  onEscape: () => void
}) {
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
            role="presentation"
            className="w-80 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none"
            initialFocus={() => document.getElementById("community-user-bar-extension")}
            finalFocus={false}
          >
            {children}
          </PopoverPopup>
        </PopoverPositioner>
      </PopoverPortal>
    </Popover>
  )
}
