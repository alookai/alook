"use client"

import { ArrowDown, ImageIcon, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NumberTicker } from "@/components/ui/number-ticker"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { COMPOSER_ACCESSORY_ROW_HEIGHT_PX } from "@/lib/community/conversation-layout"
import { allocateComposerAccessoryRail } from "./composer-accessory-rail-layout"
import { TypingIndicator } from "./typing-indicator"

export function ComposerAccessoryRail({
  typingNames,
  scrollCount,
  scrollMode,
  onScroll,
}: {
  typingNames: string[]
  scrollCount: number | undefined
  scrollMode: "scroll" | "jump"
  onScroll: () => void
}) {
  const hasTyping = typingNames.length > 0
  const hasScroll = scrollMode === "jump" || (scrollCount ?? 0) > 0
  const layout = allocateComposerAccessoryRail({
    mode: "normal",
    left: hasTyping,
    center: hasScroll,
  })

  if (layout === "empty") return null

  return (
    <div
      data-testid={tid.composerAccessoryRail}
      data-layout={layout}
      className="pointer-events-none w-full"
      style={{ height: COMPOSER_ACCESSORY_ROW_HEIGHT_PX }}
    >
      <div
        className={cn(
          "grid h-full w-full items-center gap-1 sm:gap-2",
          layout === "centered" && "grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]",
          layout === "left-only" && "grid-cols-[minmax(0,1fr)]",
        )}
      >
        {hasTyping && (
          <div className="col-start-1 h-full min-w-0 max-w-full">
            <TypingIndicator names={typingNames} className="h-full w-fit max-w-full" />
          </div>
        )}
        {hasScroll && (
          <div className="col-start-2 h-full min-w-0 max-w-full justify-self-center">
            <ScrollControl count={scrollCount} mode={scrollMode} onClick={onScroll} />
          </div>
        )}
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
  count: number | undefined
  mode: "scroll" | "jump"
  onClick: () => void
}) {
  const knownCount = count !== undefined && count > 0
  const aria = mode === "jump"
    ? knownCount ? `Jump to present, ${count} unread below` : "Jump to present"
    : `Scroll to bottom, ${count} more below`
  return (
    <button
      type="button"
      data-testid={tid.scrollToPresent}
      onClick={onClick}
      aria-label={aria}
      className="pointer-events-auto flex h-full items-center gap-1.5 justify-self-center rounded-full border border-border bg-background/90 pl-2 pr-3 text-xs font-medium text-foreground shadow-(--e1) backdrop-blur-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowDown className="size-3.5 text-muted-foreground" />
      {knownCount ? <NumberTicker value={count} /> : <span>Jump to present</span>}
    </button>
  )
}
