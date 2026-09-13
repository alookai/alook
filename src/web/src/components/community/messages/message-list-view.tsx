import type { ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { tid } from "@/lib/community/testids"
import { ChannelIcon } from "../channels/channel-icon"
import { ComposerAccessoryRail } from "./composer-accessory-rail"
import { InitialPositionAurora } from "./initial-position-aurora"
import { MessageShareDialog } from "./message-share-dialog"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

export function renderMessageListView(
  props: ResolvedMessageListProps,
  controller: MessageListController,
  renderRows: () => ReactNode,
) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {controller.shareOpen && controller.selectedMessages.length > 0 && (
        <MessageShareDialog
          m={controller.selectedMessages}
          open={controller.shareOpen}
          onClose={controller.closeShare}
        />
      )}
      <div data-message-scroller-boundary className="relative isolate min-h-0 flex-1">
        {controller.initialPosition.contentInteractive && (
          <ComposerAccessoryRail
            typingNames={props.typingUsers ?? []}
            scrollCount={controller.pillCount}
            scrollMode={controller.pillMode}
            onScroll={controller.pillOnClick}
            selectMode={controller.selectMode}
            selectedCount={controller.selectedIds.size}
            onCancelSelection={controller.exitSelect}
            onShareSelection={() => controller.setShareOpen(true)}
          />
        )}
        <div
          ref={controller.scrollRef}
          data-testid={tid.messageScroller}
          className="relative z-10 h-full overflow-x-clip overflow-y-auto thin-scrollbar"
        >
          <div
            data-message-list-content
            data-initial-position-phase={controller.initialPosition.phase}
            aria-hidden={!controller.initialPosition.showSkeleton && !controller.initialPosition.contentVisible}
            inert={!controller.initialPosition.showSkeleton && !controller.initialPosition.contentInteractive}
            className={`flex min-h-full flex-col justify-end px-4 pb-14 pt-8 sm:pb-18 ${
              controller.initialPosition.phase === "revealing"
                ? "opacity-100 transition-opacity duration-300 ease-linear motion-reduce:transition-opacity"
                : controller.initialPosition.showSkeleton || controller.initialPosition.contentVisible
                  ? "opacity-100"
                  : "pointer-events-none opacity-0"
            }`}
          >
          {controller.initialPosition.showSkeleton ? (
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
        <InitialPositionAurora phase={controller.initialPosition.phase} />
      </div>
    </div>
  )
}

export function MessageListSkeleton({ variant = "channel" }: { variant?: "channel" | "dm" }) {
  return (
    <div
      aria-busy="true"
      data-message-list-skeleton
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div data-message-scroller-boundary className="relative isolate min-h-0 flex-1">
        <div
          data-testid={tid.messageScroller}
          className="relative z-10 h-full overflow-x-clip overflow-y-auto thin-scrollbar"
        >
          <div
            data-message-list-content
            className="flex min-h-full flex-col justify-end px-4 pb-14 pt-8 sm:pb-18"
          >
            <MessageListSkeletonContent variant={variant} />
          </div>
        </div>
      </div>
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
            <Skeleton className="h-8 w-48 rounded" />
            <Skeleton className="mt-2 h-5 w-72 rounded" />
          </>
        ) : (
          <>
            <Skeleton className="mb-2 size-12 rounded-full" />
            <Skeleton className="h-7 w-40 rounded" />
            <Skeleton className="mt-2 h-5 w-80 max-w-full rounded" />
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
