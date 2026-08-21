"use client"

import * as React from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  SheetResizeHandle,
  useSheetResize,
} from "@/components/ui/sheet-resize-handle"
import { cn } from "@/lib/utils"

type WidthConfig = {
  defaultWidth: number
  minWidth: number
  maxWidthRatio: number
  resizable: boolean
}

const MODE_CONFIG: Record<"sidecar" | "task" | "preview", WidthConfig> = {
  sidecar: { defaultWidth: 380, minWidth: 280, maxWidthRatio: 0.6, resizable: true },
  task: { defaultWidth: 448, minWidth: 320, maxWidthRatio: 1, resizable: false },
  preview: { defaultWidth: 520, minWidth: 320, maxWidthRatio: 0.8, resizable: true },
}

type CommunitySheetBaseProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  closeLabel?: string
  contentTestId?: string
}

type CommunitySheetProps = CommunitySheetBaseProps & (
  | { mode: "sidecar" | "preview"; initialWidth?: number }
  | { mode: "task"; initialWidth?: never }
)

/**
 * Controlled shell for the community's right-hand surfaces.
 *
 * The mode owns interaction semantics; callers cannot independently combine
 * modal, overlay, dismissal, or checkpoint behavior. The 640px checkpoint is
 * CSS-only so an open sheet and its children stay mounted while the viewport
 * crosses it.
 */
export function CommunitySheet({
  open,
  onOpenChange,
  mode,
  initialWidth,
  children,
  closeLabel = "Close",
  contentTestId,
}: CommunitySheetProps) {
  const config = MODE_CONFIG[mode]
  const resize = useSheetResize({
    defaultWidth: Math.max(config.minWidth, initialWidth ?? config.defaultWidth),
    minWidth: config.minWidth,
    maxWidthRatio: config.maxWidthRatio,
  })
  const modal = mode !== "sidecar"

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      disablePointerDismissal={!modal}
    >
      <SheetContent
        data-testid={contentTestId}
        data-community-sheet-mode={mode}
        side="right"
        showOverlay={modal}
        showCloseButton={false}
        style={{
          "--community-sheet-width": `${resize.width}px`,
          "--community-sheet-max-width": `${config.maxWidthRatio * 100}vw`,
          maxWidth: "none",
        } as React.CSSProperties}
        className={cn(
          "data-[side=right]:h-dvh data-[side=right]:w-screen data-[side=right]:max-w-none data-[side=right]:overflow-hidden",
          "data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:w-[min(var(--community-sheet-width),var(--community-sheet-max-width),calc(100vw-1rem))] data-[side=right]:sm:rounded-xl data-[side=right]:sm:border",
        )}
      >
        {config.resizable && (
          <SheetResizeHandle
            onPointerDown={resize.onPointerDown}
            onPointerMove={resize.onPointerMove}
            onPointerUp={resize.onPointerUp}
          />
        )}
        {children}
        <SheetClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-0.5 right-0.5 z-20 size-11 sm:top-3 sm:right-3 sm:size-7"
              aria-label={closeLabel}
            />
          }
        >
          <XIcon />
          <span className="sr-only">{closeLabel}</span>
        </SheetClose>
      </SheetContent>
    </Sheet>
  )
}

export function CommunitySheetHeader({
  className,
  ...props
}: React.ComponentProps<typeof SheetHeader>) {
  return <SheetHeader className={className} {...props} />
}

export function CommunitySheetBody({
  className,
  ...props
}: React.ComponentProps<typeof SheetBody>) {
  return <SheetBody className={className} {...props} />
}

export function CommunitySheetFooter({
  className,
  ...props
}: React.ComponentProps<typeof SheetFooter>) {
  return (
    <SheetFooter
      className={cn(
        "**:data-[slot=button]:min-h-11 sm:**:data-[slot=button]:min-h-0",
        className,
      )}
      {...props}
    />
  )
}

export const CommunitySheetTitle = SheetTitle
export const CommunitySheetDescription = SheetDescription
export const CommunitySheetClose = SheetClose
