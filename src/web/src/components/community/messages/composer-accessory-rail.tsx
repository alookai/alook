"use client"

import { ArrowDown, ImageIcon, Radio, WifiOff, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NumberTicker } from "@/components/ui/number-ticker"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  allocateComposerAccessoryRail,
  type ComposerAccessoryRailLayout,
} from "./composer-accessory-rail-layout"
import { TypingIndicator } from "./typing-indicator"

export function ComposerAccessoryRail({
  typingNames,
  scrollCount,
  scrollMode,
  onScroll,
  selectMode,
  selectedCount,
  onCancelSelection,
  onShareSelection,
}: {
  typingNames: string[]
  scrollCount: number
  scrollMode: "scroll" | "jump"
  onScroll: () => void
  selectMode: boolean
  selectedCount: number
  onCancelSelection: () => void
  onShareSelection: () => void
}) {
  const connectionStatus = useCommunityWsStore((state) => state.connectionStatus)
  const reconnectNow = useCommunityWsStore((state) => state.reconnectNow)
  const hasTyping = typingNames.length > 0
  const hasScroll = scrollCount > 0
  const hasWsStatus = connectionStatus !== "connected"
  const layout = allocateComposerAccessoryRail(selectMode
    ? { mode: "selection", left: hasTyping, right: hasWsStatus }
    : { mode: "normal", left: hasTyping, center: hasScroll, right: hasWsStatus })

  if (layout === "empty") return null

  return (
    <div
      data-testid={tid.composerAccessoryRail}
      data-selection={selectMode ? "active" : "inactive"}
      data-layout={layout}
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 px-2 sm:px-4"
    >
      <div
        className={cn(
          "grid w-full items-end gap-1 sm:gap-2",
          layout === "centered" && "grid-cols-[minmax(0,1fr)_minmax(0,max-content)_minmax(0,1fr)]",
          layout === "left-right" && "grid-cols-[minmax(0,1fr)_auto]",
          (layout === "left-only" || layout === "right-only") && "grid-cols-[minmax(0,1fr)]",
        )}
      >
        {selectMode ? (
          <>
            {hasTyping && (
              <div key="left" className="hidden min-w-0 max-w-full sm:col-start-1 sm:block">
                <TypingIndicator names={typingNames} className="w-fit max-w-full" />
              </div>
            )}
            <div key="center" className="col-start-2 min-w-0 max-w-full justify-self-center">
              <SelectionToolbar
                selectedCount={selectedCount}
                onCancel={onCancelSelection}
                onShare={onShareSelection}
              />
            </div>
            {hasWsStatus && (
              <div key="right" className="col-start-3 min-w-0 max-w-full justify-self-end">
                <WsStatusControl status={connectionStatus} onRetry={reconnectNow} />
              </div>
            )}
          </>
        ) : (
          <>
            {hasTyping && (
              <div key="left" className={normalSlotClassName(layout, "left")}>
                <TypingIndicator names={typingNames} className="w-fit max-w-full" />
              </div>
            )}
            {hasScroll && (
              <div key="center" className="col-start-2 min-w-0 max-w-full justify-self-center">
                <ScrollControl count={scrollCount} mode={scrollMode} onClick={onScroll} />
              </div>
            )}
            {hasWsStatus && (
              <div key="right" className={normalSlotClassName(layout, "right")}>
                <WsStatusControl status={connectionStatus} onRetry={reconnectNow} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function normalSlotClassName(
  layout: ComposerAccessoryRailLayout,
  side: "left" | "right",
): string {
  const column = layout === "centered"
    ? side === "left" ? "col-start-1" : "col-start-3"
    : layout === "left-right"
      ? side === "left" ? "col-start-1" : "col-start-2"
      : "col-start-1"
  return cn(
    column,
    "min-w-0 max-w-full",
    side === "right" && "justify-self-end",
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
              className="relative h-8 w-11 shrink-0 rounded-lg px-0 after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] sm:h-7 sm:w-auto sm:px-2 sm:after:hidden"
            />
          }
        >
          <X /> <span className="hidden sm:inline">Cancel</span>
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

function WsStatusControl({
  status,
  onRetry,
}: {
  status: "connected" | "reconnecting" | "failed"
  onRetry: () => void
}) {
  if (status === "connected") return null
  const failed = status === "failed"
  const label = failed
    ? "WebSocket connection failed. Retry now"
    : "WebSocket reconnecting"
  const triggerClassName = cn(
    "pointer-events-auto relative grid size-11 place-items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 sm:size-10",
    failed
      ? "text-destructive hover:bg-destructive/10"
      : "cursor-default text-warning",
  )
  return (
    <Tooltip>
      <TooltipTrigger
        render={failed ? (
          <button
            type="button"
            data-testid={tid.wsRetry}
            data-ws-status={status}
            aria-label={label}
            onClick={onRetry}
            className={triggerClassName}
          />
        ) : (
          <span
            role="status"
            aria-live="polite"
            tabIndex={0}
            data-testid={tid.wsStatus}
            data-ws-status={status}
            aria-label={label}
            className={triggerClassName}
          />
        )}
      >
        {!failed && (
          <span className="absolute size-8 self-end rounded-full bg-warning/10 motion-safe:animate-pulse" />
        )}
        <span
          className={cn(
            "relative grid size-8 self-end place-items-center rounded-full border bg-background/90 shadow-(--e1) backdrop-blur-sm",
            failed ? "border-destructive/30" : "border-warning/30",
          )}
        >
          {failed ? <WifiOff className="size-4" /> : <Radio className="size-4" />}
        </span>
      </TooltipTrigger>
      <TooltipContent>{failed ? "Connection failed · Retry" : "Reconnecting…"}</TooltipContent>
    </Tooltip>
  )
}
