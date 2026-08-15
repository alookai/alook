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
  onClose,
  title,
  mutedTitle = true,
  footer,
  footerClassName,
  children,
}: {
  open?: boolean
  onClose: () => void
  title: React.ReactNode
  mutedTitle?: boolean
  // Omit for a footerless dialog.
  footer?: React.ReactNode
  footerClassName?: string
  children: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className={mutedTitle ? "text-xs font-normal text-muted-foreground" : undefined}>
            {title}
          </DialogTitle>
        </DialogHeader>
        {children}
        {footer !== undefined && (
          <DialogFooter className={cn("mx-0 mb-0 flex-row items-center gap-2 px-5 pb-5", footerClassName ?? "justify-end")}>
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
