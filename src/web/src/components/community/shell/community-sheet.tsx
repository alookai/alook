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

type CommunitySheetMode = "sidecar" | "task" | "preview"
type CommunitySheetWidth = "sm" | "md" | "lg"

type WidthConfig = {
  defaultWidth: number
  minWidth: number
  maxWidthRatio: number
}

const WIDTH_CONFIG: Record<CommunitySheetWidth, WidthConfig> = {
  sm: { defaultWidth: 380, minWidth: 280, maxWidthRatio: 0.6 },
  md: { defaultWidth: 448, minWidth: 320, maxWidthRatio: 0.7 },
  lg: { defaultWidth: 520, minWidth: 320, maxWidthRatio: 0.8 },
}

const CONTEXT_WIDTH_CONFIG: WidthConfig = {
  defaultWidth: 420,
  minWidth: 320,
  maxWidthRatio: 0.6,
}

type CommunitySheetBaseProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  width?: CommunitySheetWidth
  children: React.ReactNode
  closeLabel?: string
  contentTestId?: string
}

type CommunitySheetProps = CommunitySheetBaseProps & (
  | { mode: Exclude<CommunitySheetMode, "task">; resizable?: boolean }
  | { mode: "task"; resizable?: never }
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
  width = mode === "preview" ? "lg" : mode === "sidecar" ? "sm" : "md",
  resizable = false,
  children,
  closeLabel = "Close",
  contentTestId,
}: CommunitySheetProps) {
  // Preserve the context preview's quieter 420px sidecar width while task
  // sheets retain the existing 448px `max-w-md` geometry.
  const config = mode === "sidecar" && width === "md"
    ? CONTEXT_WIDTH_CONFIG
    : WIDTH_CONFIG[width]
  const resize = useSheetResize(config)
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
          maxWidth: "none",
        } as React.CSSProperties}
        className={cn(
          "data-[side=right]:h-dvh data-[side=right]:w-screen data-[side=right]:max-w-none data-[side=right]:overflow-hidden",
          "data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:w-[min(var(--community-sheet-width),calc(100vw-1rem))] data-[side=right]:sm:rounded-xl data-[side=right]:sm:border",
        )}
      >
        {resizable && (
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
