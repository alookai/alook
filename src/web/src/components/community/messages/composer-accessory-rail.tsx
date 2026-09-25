"use client"

import { ArrowDown, ImageIcon, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NumberTicker } from "@/components/ui/number-ticker"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { tid } from "@/lib/community/testids"

export function ComposerAccessoryRail({
  scrollCount,
  scrollMode,
  onScroll,
}: {
  scrollCount: number
  scrollMode: "scroll" | "jump"
  onScroll: () => void
}) {
  if (scrollCount <= 0) return null

  return (
    <div
      data-testid={tid.composerAccessoryRail}
      data-layout="centered"
      className="pointer-events-none absolute inset-x-0 bottom-2 z-20 px-2 sm:bottom-4 sm:px-4"
    >
      <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)] items-end">
        <div className="col-start-2 min-w-0 max-w-full justify-self-center">
          <ScrollControl count={scrollCount} mode={scrollMode} onClick={onScroll} />
        </div>
      </div>
    </div>
  )
}

export function MessageSelectionFooter({
  selectedCount,
  onCancel,
  onShare,
}: {
  selectedCount: number
  onCancel: () => void
  onShare: () => void
}) {
  return (
    <div
      data-selection="active"
      className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-(--app-bg) px-2 pb-(--app-safe-area-bottom) sm:px-4 sm:pb-0"
    >
      <SelectionToolbar selectedCount={selectedCount} onCancel={onCancel} onShare={onShare} />
    </div>
  )
}

function SelectionToolbar({
  selectedCount,
  onCancel,
  onShare,
}: {
  selectedCount: number
  onCancel: () => void
  onShare: () => void
}) {
  return (
    <div
      data-testid={tid.messageSelectionToolbar}
      className="pointer-events-auto flex h-10 w-fit min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 bg-card p-1 shadow-(--e2) sm:h-auto"
    >
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground sm:px-2 sm:text-sm">
        {selectedCount} selected
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              aria-label="Cancel message selection"
              className="relative h-8 w-11 shrink-0 rounded-lg px-0 text-foreground after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] sm:h-7 sm:w-auto sm:px-2 sm:after:hidden"
            />
          }
        >
          <X className="text-foreground" /> <span className="hidden text-foreground sm:inline">Cancel</span>
        </TooltipTrigger>
        <TooltipContent>Cancel selection</TooltipContent>
      </Tooltip>
      <Button
        size="sm"
        disabled={selectedCount === 0}
        onClick={onShare}
        aria-label={`Share ${selectedCount} selected messages as image`}
        className="relative h-8 shrink-0 rounded-lg px-2 after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] sm:h-7 sm:after:hidden"
      >
        <ImageIcon />
        <span className="sm:hidden">Share</span>
        <span className="hidden sm:inline">Share image</span>
      </Button>
    </div>
  )
}

function ScrollControl({
  count,
  mode,
  onClick,
}: {
  count: number
  mode: "scroll" | "jump"
  onClick: () => void
}) {
  if (count <= 0) return null
  const aria = mode === "jump"
    ? `Jump to present, ${count} unread below`
    : `Scroll to bottom, ${count} more below`
  return (
    <button
      type="button"
      data-testid={tid.scrollToPresent}
      onClick={onClick}
      aria-label={aria}
      className="pointer-events-auto flex h-8 items-center gap-1.5 justify-self-center rounded-full border border-border bg-background/90 pl-2 pr-3 text-xs font-medium text-foreground shadow-(--e1) backdrop-blur-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowDown className="size-3.5 text-muted-foreground" />
      <NumberTicker value={count} />
    </button>
  )
}
