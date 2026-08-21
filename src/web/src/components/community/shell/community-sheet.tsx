"use client"

import * as React from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetBody,
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

const COMMUNITY_SHEET_WIDTH = 480

type CommunitySheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  headerActions?: React.ReactNode
  footer?: React.ReactNode | ((requestClose: () => void) => React.ReactNode)
  children: React.ReactNode
  bodyClassName?: string
  bodyRef?: React.Ref<HTMLDivElement>
  resizable?: boolean
  closeLabel?: string
  contentTestId?: string
  bodyTestId?: string
}

/**
 * Controlled modal shell for every community right-hand surface.
 *
 * The shell owns structure, dismissal, width, and the CSS-only 640px
 * checkpoint. Callers supply business content through the title, actions,
 * body, and optional footer slots. Attachment preview is the only caller that
 * opts into the fixed internal resize policy.
 */
export function CommunitySheet({
  open,
  onOpenChange,
  title,
  description,
  headerActions,
  footer,
  children,
  bodyClassName,
  bodyRef,
  resizable = false,
  closeLabel = "Close",
  contentTestId,
  bodyTestId,
}: CommunitySheetProps) {
  const requestClose = React.useCallback(() => onOpenChange(false), [onOpenChange])
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) onOpenChange(true)
      else requestClose()
    },
    [onOpenChange, requestClose],
  )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange} modal>
      {resizable ? (
        <ResizableCommunitySheetContent
          title={title}
          description={description}
          headerActions={headerActions}
          footer={footer}
          bodyClassName={bodyClassName}
          bodyRef={bodyRef}
          closeLabel={closeLabel}
          contentTestId={contentTestId}
          bodyTestId={bodyTestId}
          requestClose={requestClose}
        >
          {children}
        </ResizableCommunitySheetContent>
      ) : (
        <CommunitySheetContent
          width={COMMUNITY_SHEET_WIDTH}
          maxWidth="100vw"
          title={title}
          description={description}
          headerActions={headerActions}
          footer={footer}
          bodyClassName={bodyClassName}
          bodyRef={bodyRef}
          closeLabel={closeLabel}
          contentTestId={contentTestId}
          bodyTestId={bodyTestId}
          requestClose={requestClose}
        >
          {children}
        </CommunitySheetContent>
      )}
    </Sheet>
  )
}

type CommunitySheetContentProps = Pick<
  CommunitySheetProps,
  | "title"
  | "description"
  | "headerActions"
  | "footer"
  | "children"
  | "bodyClassName"
  | "bodyRef"
  | "closeLabel"
  | "contentTestId"
  | "bodyTestId"
> & {
  width: number
  maxWidth: string
  requestClose: () => void
  resize?: React.ComponentProps<typeof SheetResizeHandle>
}

function CommunitySheetContent({
  width,
  maxWidth,
  resize,
  title,
  description,
  headerActions,
  footer,
  children,
  bodyClassName,
  bodyRef,
  closeLabel,
  contentTestId,
  bodyTestId,
  requestClose,
}: CommunitySheetContentProps) {
  const footerContent = typeof footer === "function" ? footer(requestClose) : footer

  return (
    <SheetContent
      data-testid={contentTestId}
      side="right"
      showOverlay
      showCloseButton={false}
      style={{
        "--community-sheet-width": `${width}px`,
        "--community-sheet-max-width": maxWidth,
        maxWidth: "none",
      } as React.CSSProperties}
      className={cn(
        "data-[side=right]:h-dvh data-[side=right]:w-screen data-[side=right]:max-w-none data-[side=right]:overflow-hidden",
        "data-[side=right]:sm:inset-y-2 data-[side=right]:sm:right-2 data-[side=right]:sm:h-auto data-[side=right]:sm:w-[min(var(--community-sheet-width),var(--community-sheet-max-width),calc(100vw-1rem))] data-[side=right]:sm:rounded-xl data-[side=right]:sm:border",
      )}
    >
      {resize && <SheetResizeHandle {...resize} />}
      <SheetHeader className="pr-14 sm:pr-14">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate">{title}</SheetTitle>
            {description != null && <SheetDescription>{description}</SheetDescription>}
          </div>
          {headerActions != null && <div className="shrink-0">{headerActions}</div>}
        </div>
      </SheetHeader>
      <SheetBody ref={bodyRef} data-testid={bodyTestId} className={bodyClassName}>
        {children}
      </SheetBody>
      {footerContent != null && (
        <SheetFooter className="**:data-[slot=button]:min-h-11 sm:**:data-[slot=button]:min-h-0">
          {footerContent}
        </SheetFooter>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-0.5 right-0.5 z-20 size-11 sm:top-3 sm:right-3 sm:size-7"
        aria-label={closeLabel}
        onClick={requestClose}
      >
        <XIcon />
        <span className="sr-only">{closeLabel}</span>
      </Button>
    </SheetContent>
  )
}

type ResizableCommunitySheetContentProps = Omit<
  CommunitySheetContentProps,
  "width" | "maxWidth" | "resize"
>

function ResizableCommunitySheetContent(props: ResizableCommunitySheetContentProps) {
  const resize = useSheetResize()

  return (
    <CommunitySheetContent {...props} width={resize.width} maxWidth="80vw" resize={resize} />
  )
}
