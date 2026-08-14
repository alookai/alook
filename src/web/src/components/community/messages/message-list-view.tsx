import type { ReactNode } from "react"
import { ArrowDown, ImageIcon, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { NumberTicker } from "@/components/ui/number-ticker"
import { ChannelIcon } from "../channels/channel-icon"
import { MessageShareDialog } from "./message-share-dialog"
import { TypingIndicator } from "./typing-indicator"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

export function renderMessageListView(
  props: ResolvedMessageListProps,
  controller: MessageListController,
  renderRows: () => ReactNode,
) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollDownButton
        count={controller.isLoading ? 0 : controller.pillCount}
        mode={controller.pillMode}
        onClick={controller.pillOnClick}
      />
      {controller.selectMode && (
        <div className="absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
          <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card px-2 py-1.5 shadow-(--e2)">
            <span className="px-2 text-sm text-muted-foreground">
              {controller.selectedIds.size} selected
            </span>
            <Button size="sm" variant="ghost" onClick={controller.exitSelect}>
              <X /> Cancel
            </Button>
            <Button
              size="sm"
              disabled={controller.selectedIds.size === 0}
              onClick={() => controller.setShareOpen(true)}
            >
              <ImageIcon /> Share {controller.selectedIds.size} as image
            </Button>
          </div>
        </div>
      )}
      {controller.shareOpen && controller.selectedMessages.length > 0 && (
        <MessageShareDialog
          m={controller.selectedMessages}
          open={controller.shareOpen}
          onClose={controller.closeShare}
        />
      )}
      <TypingIndicator names={controller.isLoading ? [] : props.typingUsers ?? []} />
      <div
        ref={controller.scrollRef}
        className="flex-1 overflow-x-clip overflow-y-auto thin-scrollbar"
      >
        <div className="flex min-h-full flex-col justify-end px-4 py-8">
          {controller.isLoading ? (
            <MessageListSkeletonContent variant={props.variant} />
          ) : (
            <>
              <div ref={controller.heroRef} className="mb-6">
                {props.hasMore ? (
                  <div
                    ref={controller.topSentinelRef}
                    className="flex h-8 items-center justify-center text-xs text-muted-foreground"
                  >
                    {props.isFetchingOlder ? "Loading older messages…" : ""}
                  </div>
                ) : (
                  props.hero ?? (
                    <>
                      <div className="mb-2 grid size-12 place-items-center rounded-full bg-muted/60">
                        <ChannelIcon className="text-xl text-muted-foreground" />
                      </div>
                      <h2 className="text-xl font-semibold leading-tight">{props.channel}</h2>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Beginning of the channel. Say hello, share what you&apos;re working on, or drop a link.
                      </p>
                    </>
                  )
                )}
              </div>

              {renderRows()}

              {props.hasMoreNewer && (
                <div
                  ref={controller.bottomSentinelRef}
                  className="mt-6 flex h-8 items-center justify-center text-xs text-muted-foreground"
                >
                  {props.isFetchingNewer ? "Loading newer messages…" : ""}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ScrollDownButton({
  count,
  mode = "scroll",
  onClick,
}: {
  count: number
  mode?: "scroll" | "jump"
  onClick: () => void
}) {
  const visible = count > 0
  const aria = mode === "jump"
    ? `Jump to present, ${count} unread below`
    : `Scroll to bottom, ${count} more below`
  return (
    <div
      className={`pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 transition-all duration-200 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={aria}
        className={`pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/90 pl-2 pr-3 text-xs font-medium text-foreground shadow-(--e1) backdrop-blur-sm transition-colors hover:bg-accent ${
          visible ? "" : "pointer-events-none"
        }`}
      >
        <ArrowDown className="size-3.5 text-muted-foreground" />
        <NumberTicker value={count} />
      </button>
    </div>
  )
}

function MessageListSkeletonContent({ variant }: { variant: "channel" | "dm" }) {
  const clusters: number[][] = [
    [220, 140],
    [180],
    [260, 90, 200],
    [120, 240],
    [200],
  ]
  return (
    <>
      <div className="mb-6">
        {variant === "dm" ? (
          <>
            <Skeleton className="mb-3 size-16 rounded-full" />
            <Skeleton className="h-7 w-48 rounded" />
            <Skeleton className="mt-2 h-3.5 w-72 rounded" />
          </>
        ) : (
          <>
            <Skeleton className="mb-2 size-12 rounded-full" />
            <Skeleton className="h-5 w-40 rounded" />
            <Skeleton className="mt-2 h-3.5 w-80 max-w-full rounded" />
          </>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {clusters.map((lines, index) => (
          <div key={index} className="flex gap-3 pt-1.5">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-24 rounded" />
                <Skeleton className="h-3 w-14 rounded" />
              </div>
              {lines.map((width, lineIndex) => (
                <Skeleton key={lineIndex} className="h-3.5 rounded" style={{ width }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
