"use client"

import { useRef, type MutableRefObject, type ReactNode, type RefObject } from "react"
import { Inbox } from "lucide-react"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
  PopoverPopup,
  PopoverPortal,
  PopoverPositioner,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { Breakpoint } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { COMMUNITY_USER_BAR_HEIGHT_CSS } from "./shell-frame-geometry"

type Props = {
  breakpoint: Breakpoint
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hasUnread?: boolean
  anchorRef: RefObject<HTMLDivElement | null>
  suppressFocusReturnRef: MutableRefObject<boolean>
  children: ReactNode
}

export function CommunityInboxSurface({
  breakpoint,
  open,
  onOpenChange,
  hasUnread,
  anchorRef,
  suppressFocusReturnRef,
  children,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mobile = breakpoint === "mobile"

  return (
    <Popover
      open={open}
      modal={false}
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) suppressFocusReturnRef.current = false
        else if (
          details.reason === "outside-press"
          && typeof Element !== "undefined"
          && details.event.target instanceof Element
          && details.event.target.closest(`[data-testid='${tid.userBar}']`)
        ) {
          suppressFocusReturnRef.current = true
        }
        onOpenChange?.(nextOpen)
      }}
    >
      <PopoverTrigger
        render={
          <button
            ref={triggerRef}
            data-testid={tid.inboxTrigger}
            className="relative grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-7"
            aria-label={mobile ? (open ? "Close Inbox" : "Open Inbox") : "Inbox"}
            aria-pressed={mobile ? open : undefined}
          />
        }
      >
        <Inbox className={cn("size-4", mobile && open && "fill-current")} />
        {hasUnread && (
          <span className="absolute right-1 top-1 size-2 rounded-full bg-primary" />
        )}
      </PopoverTrigger>

      {mobile ? (
        <PopoverPortal>
          <PopoverBackdrop
            data-testid={tid.inboxMobileBackdrop}
            className="fixed inset-x-0"
            style={{
              top: "var(--app-safe-area-top)",
              bottom: COMMUNITY_USER_BAR_HEIGHT_CSS,
            }}
          />
          <PopoverPositioner
            anchor={anchorRef}
            positionMethod="fixed"
            side="top"
            align="start"
            sideOffset={0}
            collisionAvoidance={{
              side: "none",
              align: "none",
              fallbackAxisSide: "none",
            }}
          >
            <PopoverPopup
              data-testid={tid.inboxMobileSurface}
              initialFocus={false}
              finalFocus={() => (
                suppressFocusReturnRef.current ? false : triggerRef.current
              )}
              className="w-(--anchor-width) origin-bottom border-0 bg-transparent p-0 shadow-none"
            >
              <PopoverTitle className="sr-only">Inbox</PopoverTitle>
              <div
                data-testid={tid.inboxMobileCard}
                className="relative min-h-0 overflow-hidden rounded-t-xl border border-border bg-popover text-popover-foreground shadow-(--e2)"
                style={{
                  height: `min(28rem, max(0px, calc(100dvh - ${COMMUNITY_USER_BAR_HEIGHT_CSS} - var(--app-safe-area-top))))`,
                }}
              >
                {children}
              </div>
            </PopoverPopup>
          </PopoverPositioner>
        </PopoverPortal>
      ) : (
        <PopoverContent
          side="top"
          align="end"
          className="w-90 max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        >
          {children}
        </PopoverContent>
      )}
    </Popover>
  )
}
