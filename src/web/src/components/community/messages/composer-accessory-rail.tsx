"use client"

import { ArrowDown, ImageIcon, Radio, WifiOff, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NumberTicker } from "@/components/ui/number-ticker"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { useCommunityWsStore } from "@/stores/community/ws"
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

  return (
    <div
      data-testid={tid.composerAccessoryRail}
      data-selection={selectMode ? "active" : "inactive"}
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 px-3 sm:px-4"
    >
      <div
        className={cn(
          "grid w-full items-end gap-2",
          selectMode
            ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
            : "grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
        )}
      >
        {selectMode ? (
          <>
            <div className="hidden w-full min-w-0 sm:col-start-1 sm:block">
              <TypingIndicator names={typingNames} className="w-fit" />
            </div>
            <div className="col-start-1 min-w-0 justify-self-center sm:col-start-2">
              <SelectionToolbar
                selectedCount={selectedCount}
                onCancel={onCancelSelection}
                onShare={onShareSelection}
              />
            </div>
            <div className="col-start-2 justify-self-end sm:col-start-3">
              <WsStatusControl status={connectionStatus} onRetry={reconnectNow} />
            </div>
          </>
        ) : (
          <>
            <div className="col-start-1 w-full min-w-0">
              <TypingIndicator names={typingNames} className="w-fit" />
            </div>
            <div className="col-start-2 justify-self-center">
              <ScrollControl count={scrollCount} mode={scrollMode} onClick={onScroll} />
            </div>
            <div className="col-start-3 justify-self-end">
              <WsStatusControl status={connectionStatus} onRetry={reconnectNow} />
            </div>
          </>
        )}
      </div>
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
      className="pointer-events-auto flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 bg-card p-1 shadow-(--e2)"
    >
      <span className="min-w-0 truncate px-2 text-xs text-muted-foreground sm:text-sm">
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
              className="size-11 rounded-full px-0 sm:h-7 sm:w-auto sm:rounded-lg sm:px-2"
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
        className="h-11 rounded-full px-3 sm:h-7 sm:rounded-lg sm:px-2"
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
          <span className="absolute size-8 rounded-full bg-warning/10 motion-safe:animate-pulse" />
        )}
        <span
          className={cn(
            "relative grid size-8 place-items-center rounded-full border bg-background/90 shadow-(--e1) backdrop-blur-sm",
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
