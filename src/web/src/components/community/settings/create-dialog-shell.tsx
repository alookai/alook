"use client"

import type React from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

// The shared frameless shell for the community create/edit dialogs
// (create-server / create-channel / create-category / category-settings).
// Extracted so the four stop copy-pasting the same unframed Dialog scaffold —
// a single source for the 105-width container, the padding rhythm, the quiet
// breadcrumb header, and the floating (borderless) footer. Body + footer
// content are passed in; the shell only owns the frame.
//
// `title` is usually the quiet breadcrumb ("New channel in DEV"). Callers can
// opt into a full-weight heading or a different footer alignment when needed.
export function CreateDialogShell({
  open = true,
  preview = false,
  onClose,
  title,
  mutedTitle = true,
  footer,
  footerClassName,
  children,
}: {
  open?: boolean
  /** Noninteractive, inline rendering for product walkthroughs. */
  preview?: boolean
  onClose: () => void
  title: React.ReactNode
  mutedTitle?: boolean
  // Omit for a footerless dialog.
  footer?: React.ReactNode
  footerClassName?: string
  children: React.ReactNode
}) {
  const content = <>
    <DialogHeader className="px-5 pt-5 pb-0">
      {preview ? <div className={mutedTitle ? "text-xs font-normal text-muted-foreground" : "font-semibold"}>{title}</div> :
        <DialogTitle className={mutedTitle ? "text-xs font-normal text-muted-foreground" : undefined}>{title}</DialogTitle>}
    </DialogHeader>
    {children}
    {footer !== undefined && <DialogFooter className={cn("mx-0 mb-0 flex-row items-center gap-2 px-5 pb-5", footerClassName ?? "justify-end")}>{footer}</DialogFooter>}
  </>
  if (preview) return <div inert data-slot="dialog-content" className="absolute left-1/2 top-1/2 z-20 grid w-(--motion-sheet-width,420px) -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-0 text-sm text-popover-foreground ring-1 ring-foreground/10">{content}</div>
  return <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
    <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">{content}</DialogContent>
  </Dialog>
}
