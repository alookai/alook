import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { ConversationResolutionErrorFrame } from "../channels/conversation-resolution-error-frame"
import { Skeleton } from "@/components/ui/skeleton"
import { tid } from "@/lib/community/testids"
import { CONVERSATION_TAIL_SPACE_PX } from "@/lib/community/conversation-layout"
import { renderMessageListHero } from "./message-list-row"
import { ComposerAccessoryRail, MessageSelectionFooter } from "./composer-accessory-rail"
import dynamic from "next/dynamic"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

const MessageShareDialog = dynamic(() => import("./message-share-dialog").then((module) => module.MessageShareDialog), { loading: () => null })

export function renderMessageListView(
  props: ResolvedMessageListProps,
  controller: MessageListController,
  renderRows: () => ReactNode,
  footerSlot: HTMLDivElement | null = null,
  accessoryFooterSlot: HTMLDivElement | null = null,
) {
  const showError = props.messages.length === 0 && !!props.initialLoadError
  const showSkeleton = controller.initialPosition.showSkeleton && !showError
  const hideContent = showSkeleton && controller.initialPosition.phase === "positioning"
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {controller.selectMode && footerSlot && createPortal(
        <MessageSelectionFooter
          selectedCount={controller.selectedIds.size}
          onCancel={controller.exitSelect}
          onShare={() => controller.setShareOpen(true)}
        />,
        footerSlot,
      )}
      {controller.initialPosition.contentInteractive && !controller.selectMode && accessoryFooterSlot && createPortal(
        <ComposerAccessoryRail
          typingNames={props.typingUsers ?? []}
          scrollCount={controller.pillCount}
          scrollMode={controller.pillMode}
          onScroll={controller.pillOnClick}
        />,
        accessoryFooterSlot,
      )}
      {controller.shareOpen && controller.selectedMessages.length > 0 && (
        <MessageShareDialog
          m={controller.selectedMessages}
          open={controller.shareOpen}
          onClose={controller.closeShare}
        />
      )}
      <div data-message-scroller-boundary className="relative isolate min-h-0 flex-1">
        <div
          ref={controller.scrollRef}
          data-testid={tid.messageScroller}
          data-pagination-enabled={controller.paginationEnabled ? "true" : "false"}
          aria-busy={showSkeleton}
          tabIndex={showSkeleton ? 0 : undefined}
          className="relative z-10 h-full overflow-x-clip overflow-y-auto thin-scrollbar"
        >
          <div
            data-message-list-content
            data-initial-position-phase={controller.initialPosition.phase}
            data-read-position-ready={controller.readPositionReady ? "true" : "false"}
            aria-hidden={hideContent}
            inert={hideContent}
            style={{ visibility: hideContent ? "hidden" : undefined }}
            className={`${props.messages.length === 0 ? "flex min-h-full flex-col justify-end pt-8" : ""} pl-(--community-composer-inline-start) pr-(--community-composer-inline-end)`}
          >
          {showError ? (
            <ConversationResolutionErrorFrame as="div" retrying={!!props.retryingInitialLoad}
              onRetry={props.onRetryInitialLoad ?? (() => {})} />
          ) : controller.initialPosition.phase === "skeleton" ? (
            <MessageListSkeletonContent variant={props.variant} />
          ) : (
            <>
              {props.messages.length === 0
                ? <>
                    {props.historyStartKnown && <div className="mb-6">{renderMessageListHero(props)}</div>}
                    <div aria-hidden="true" data-message-empty-tail className="shrink-0" style={{ height: CONVERSATION_TAIL_SPACE_PX }} />
                  </>
                : renderRows()}
            </>
          )}
          </div>
        </div>
        {hideContent && (
          <div
            data-message-list-skeleton
            data-message-positioning-skeleton
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 overflow-hidden bg-background"
          >
            <div className="flex min-h-full flex-col justify-end pt-8 pl-(--community-composer-inline-start) pr-(--community-composer-inline-end)">
              <MessageListSkeletonContent variant={props.variant} />
            </div>
          </div>
        )}
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
          data-pagination-enabled="false"
          className="relative z-10 h-full overflow-x-clip overflow-y-auto thin-scrollbar"
        >
          <div
            data-message-list-content
            className="flex min-h-full flex-col justify-end pl-(--community-composer-inline-start) pr-(--community-composer-inline-end) pt-8"
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
      <div
        aria-hidden="true"
        data-message-list-skeleton-tail
        className="shrink-0"
        style={{ height: CONVERSATION_TAIL_SPACE_PX }}
      />
    </>
  )
}
