import { observeVisibilitySentinel } from "@/lib/observe-visibility-sentinel"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { memo, useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Users } from "@/components/icons/lucide";
import {
  anchoredPopoverStyle,
  useAnchoredPopover,
} from "@/hooks/use-anchored-popover"
import {
  COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
  measureCommunityVirtualizerElement,
  observeCommunityVirtualizerRect,
} from "@/hooks/community/virtualizer-react-options"
import { Avatar } from "../avatar"
import { ChannelIcon } from "../channels/channel-icon"
import { nextListScrollTop } from "@/lib/community/popup-scroll"
import { tid } from "@/lib/community/testids"
import {
  toChannelRefCommandProps,
  type ChannelRefCandidate,
  type ChannelRefCandidatePresentation,
  type ChannelRefPopupState,
} from "@/lib/community/channel-ref-extension"
import type {
  MentionCandidatePresentation,
  MentionItem,
  MentionPopupState,
} from "@/lib/community/mention-extension"

import type { MentionCandidateSource } from "./composer-types"

const POPUP_WIDTH = 256
const POPUP_MAX_HEIGHT = 240
const MENTION_ROW_ESTIMATE = 40
const MENTION_HEADER_EXTRA_HEIGHT = 28
const CHANNEL_REF_ROW_ESTIMATE = 36

function scrollSelectedRowIntoView(
  list: HTMLDivElement | null,
  selectedIndex: number,
  itemCount: number,
  virtualizer: {
    measurementsCache: ReadonlyArray<{ start: number; size: number }>
    scrollToIndex: (index: number, options?: { align?: "auto" | "start" | "center" | "end" }) => void
  },
): void {
  if (!list || selectedIndex < 0 || selectedIndex >= itemCount) return
  const measurement = virtualizer.measurementsCache[selectedIndex]
  if (measurement) {
    const nextTop = nextListScrollTop(
      list.scrollTop,
      list.clientHeight,
      measurement.start,
      measurement.size,
    )
    if (nextTop !== list.scrollTop) {
      list.scrollTop = nextTop
    }
    return
  }
  virtualizer.scrollToIndex(selectedIndex, { align: "auto" })
}

export function CommunityMentionList({
  state,
  presentation,
  pagination,
}: {
  state: MentionPopupState
  presentation: MentionCandidatePresentation
  pagination?: MentionCandidateSource
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { items, selectedIndex, command, getRect } = state
  const geometry = useAnchoredPopover(
    getRect,
    command !== null,
  )
  const firstMemberIndex = items.findIndex((item) => item.kind === "member")
  const hasVirtual = items.some((item) => item.kind !== "member")
  const showMembersHeader = hasVirtual && firstMemberIndex > 0
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: geometry && command ? items.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (
      showMembersHeader && index === firstMemberIndex
        ? MENTION_ROW_ESTIMATE + MENTION_HEADER_EXTRA_HEIGHT
        : MENTION_ROW_ESTIMATE
    ),
    overscan: 6,
    initialRect: { width: POPUP_WIDTH, height: POPUP_MAX_HEIGHT },
    measureElement: measureCommunityVirtualizerElement,
    observeElementRect: observeCommunityVirtualizerRect,
  })
  const handleSelectItem = useCallback((item: MentionItem) => {
    command?.({ id: item.id, label: item.label })
  }, [command])
  useEffect(() => {
    scrollSelectedRowIntoView(listRef.current, selectedIndex, items.length, virtualizer)
  }, [selectedIndex, geometry, items.length, virtualizer])
  useEffect(() => {
    const root = listRef.current
    const sentinel = sentinelRef.current
    if (!geometry || !command || !root || !sentinel || !pagination?.hasMore
      || pagination.loading || pagination.loadingMore || pagination.failed
      || presentation.status === "loading" || !pagination.loadMore) return
    return observeVisibilitySentinel(root, sentinel, () => pagination.loadMore?.())
  }, [geometry, command, pagination, presentation.status])
  if (!geometry || !command) return null

  const virtualItems = virtualizer.getVirtualItems()
  return createPortal(
    <div
      data-testid={tid.mentionPopup}
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--e2)"
      style={anchoredPopoverStyle(
        geometry.rect,
        geometry.viewport,
        POPUP_WIDTH,
        POPUP_MAX_HEIGHT,
      )}
    >
      <ScrollArea
        viewportRef={listRef}
        viewportClassName="relative overflow-x-hidden overflow-y-auto"
        viewportProps={{ style: { maxHeight: "var(--anchored-popover-max-height)" } }}
      >
        {items.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const item = items[virtualItem.index]
              if (!item) return null
              return (
                <div
                  key={`${item.kind}:${item.id}`}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <MentionRow
                    item={item}
                    selected={virtualItem.index === selectedIndex}
                    showMembersHeader={
                      showMembersHeader && virtualItem.index === firstMemberIndex
                    }
                    onSelect={handleSelectItem}
                  />
                </div>
              )
            })}
          </div>
        )}
        {pagination?.hasMore && <div ref={sentinelRef} aria-hidden="true" className="h-px" />}
        {pagination?.failed && pagination.retry && (
          <Button variant="ghost" size="sm" type="button" className="h-11 w-full text-sm sm:h-9"
            onMouseDown={event => event.preventDefault()} onClick={pagination.retry}>Retry</Button>
        )}
        {presentation.status !== "ready" && (
          <MentionStatus status={presentation.status} hasItems={items.length > 0} />
        )}
      </ScrollArea>
    </div>,
    document.body,
  )
}

function MentionStatus({
  status,
  hasItems,
}: {
  status: Exclude<MentionCandidatePresentation["status"], "ready">
  hasItems: boolean
}) {
  const label = status === "error"
    ? "Couldn’t load members"
    : status === "empty"
      ? "No matching members"
      : status === "loading-more" && hasItems
        ? "Loading more…"
        : "Loading members…"
  return (
    <div
      data-testid={tid.mentionStatus}
      data-state={status}
      className="px-2 py-2 text-xs text-muted-foreground"
    >
      {label}
    </div>
  )
}

export function ChannelRefList({
  state,
  presentation,
}: {
  state: ChannelRefPopupState
  presentation?: ChannelRefCandidatePresentation
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const { items, selectedIndex, command, getRect } = state
  const visible = command !== null && (items.length > 0 || presentation !== undefined)
  const geometry = useAnchoredPopover(
    getRect,
    visible,
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: geometry && visible ? items.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => CHANNEL_REF_ROW_ESTIMATE,
    overscan: 6,
    initialRect: { width: POPUP_WIDTH, height: POPUP_MAX_HEIGHT },
    measureElement: measureCommunityVirtualizerElement,
    observeElementRect: observeCommunityVirtualizerRect,
  })
  const handleSelectChannel = useCallback((item: ChannelRefCandidate) => {
    command?.(toChannelRefCommandProps(item))
  }, [command])
  useEffect(() => {
    scrollSelectedRowIntoView(listRef.current, selectedIndex, items.length, virtualizer)
  }, [selectedIndex, geometry, items.length, virtualizer])
  if (!geometry || !visible) return null

  const spansMultipleServers = items.some(
    (item) => item.serverId !== items[0]?.serverId,
  )
  const virtualItems = virtualizer.getVirtualItems()
  return createPortal(
    <div
      data-testid={tid.channelRefPopup}
      className="fixed z-100 w-64 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--e2)"
      style={anchoredPopoverStyle(
        geometry.rect,
        geometry.viewport,
        POPUP_WIDTH,
        POPUP_MAX_HEIGHT,
      )}
    >
      <ScrollArea
        viewportRef={listRef}
        viewportClassName="relative overflow-x-hidden overflow-y-auto"
        viewportProps={{ style: { maxHeight: "var(--anchored-popover-max-height)" } }}
      >
        {items.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const item = items[virtualItem.index]
              if (!item) return null
              return (
                <div
                  key={item.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  <ChannelRefRow
                    item={item}
                    selected={virtualItem.index === selectedIndex}
                    showServerPrefix={spansMultipleServers}
                    onSelect={handleSelectChannel}
                  />
                </div>
              )
            })}
          </div>
        )}
        {presentation && presentation.status !== "ready" && (
          <ChannelRefStatus status={presentation.status} />
        )}
      </ScrollArea>
    </div>,
    document.body,
  )
}

function ChannelRefStatus({
  status,
}: {
  status: Exclude<ChannelRefCandidatePresentation["status"], "ready">
}) {
  const label = status === "error"
    ? "Couldn’t load channels"
    : status === "empty"
      ? "No matching channels"
      : "Loading channels…"
  return (
    <div
      data-testid={tid.channelRefStatus}
      data-state={status}
      className="px-2 py-2 text-xs text-muted-foreground"
    >
      {label}
    </div>
  )
}

const ChannelRefRow = memo(function ChannelRefRow({
  item,
  selected,
  showServerPrefix,
  onSelect,
}: {
  item: ChannelRefCandidate
  selected: boolean
  showServerPrefix: boolean
  onSelect: (item: ChannelRefCandidate) => void
}) {
  return (
    <button
      type="button"
      role="option"
      data-testid={tid.channelRefOption(item.id)}
      aria-selected={selected}
      title={showServerPrefix ? `${item.serverName} / ${item.name}` : item.name}
      className={[
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/50",
      ].join(" ")}
      onMouseDown={(event) => {
        event.preventDefault()
        onSelect(item)
      }}
    >
      <span data-suggestion-icon className="inline-flex shrink-0">
        <ChannelIcon className="size-3.5 text-muted-foreground" />
      </span>
      <span
        data-suggestion-label
        className="min-w-0 flex-1 truncate font-medium"
      >
        {showServerPrefix && (
          <span className="text-muted-foreground">{item.serverName} / </span>
        )}
        {item.name}
      </span>
    </button>
  )
})

export const MentionRow = memo(function MentionRow({
  item,
  selected,
  showMembersHeader,
  onSelect,
}: {
  item: MentionItem
  selected: boolean
  showMembersHeader: boolean
  onSelect: (item: MentionItem) => void
}) {
  return (
    <>
      {showMembersHeader && (
        <div className="-mx-1 mt-1 border-t border-border/60 px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
          Members
        </div>
      )}
      <button
        type="button"
        role="option"
        data-testid={tid.mentionOption(item.id)}
        aria-selected={selected}
        title={item.kind === "member" ? `${item.name}#${item.discriminator}` : `@${item.label}`}
        className={[
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/50",
        ].join(" ")}
        onMouseDown={(event) => {
          event.preventDefault()
          onSelect(item)
        }}
      >
        {item.kind === "member" ? (
          <span data-suggestion-icon className="shrink-0">
            <Avatar
              label={item.avatar}
              seed={item.userId}
              size={24}
              presence={item.status}
              ringColor="var(--popover)"
            />
          </span>
        ) : (
          <span
            data-suggestion-icon
            className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-primary"
          >
            <Users className="size-3.5" />
          </span>
        )}
        {item.kind === "member" ? (
          <span className="flex min-w-0 flex-1 items-baseline font-medium">
            <span data-suggestion-label className="min-w-0 truncate">
              {item.name}
            </span>
            <span
              data-suggestion-discriminator
              className="ml-1 shrink-0 text-xs font-normal tracking-wide text-muted-foreground"
            >
              #{item.discriminator}
            </span>
          </span>
        ) : (
          <span
            data-suggestion-label
            className="min-w-0 flex-1 truncate font-medium"
          >
            @{item.label}
          </span>
        )}
        {item.kind !== "member" && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            Notify everyone
          </span>
        )}
      </button>
    </>
  )
})
