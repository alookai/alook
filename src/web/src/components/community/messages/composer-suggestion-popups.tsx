import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { Users } from "lucide-react"
import {
  anchoredPopoverStyle,
  useAnchoredPopover,
} from "@/hooks/use-anchored-popover"
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

const POPUP_WIDTH = 256
const POPUP_MAX_HEIGHT = 240

function scrollSelectedRowIntoView(list: HTMLDivElement | null): void {
  if (!list) return
  const row = list.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!row) return
  list.scrollTop = nextListScrollTop(
    list.scrollTop,
    list.clientHeight,
    row.offsetTop,
    row.offsetHeight,
  )
}

export function CommunityMentionList({
  state,
  presentation,
}: {
  state: MentionPopupState
  presentation: MentionCandidatePresentation
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const { items, selectedIndex, command, getRect } = state
  const geometry = useAnchoredPopover(
    getRect,
    command !== null,
  )
  useEffect(() => {
    scrollSelectedRowIntoView(listRef.current)
  }, [selectedIndex, geometry])
  if (!geometry || !command) return null

  const firstMemberIndex = items.findIndex((item) => item.kind === "member")
  const hasVirtual = items.some((item) => item.kind !== "member")
  const showMembersHeader = hasVirtual && firstMemberIndex > 0
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
      <div
        ref={listRef}
        className="relative overflow-x-hidden overflow-y-auto thin-scrollbar"
        style={{ maxHeight: "var(--anchored-popover-max-height)" }}
      >
        {items.map((item, index) => (
          <MentionRow
            key={`${item.kind}:${item.id}`}
            item={item}
            selected={index === selectedIndex}
            showMembersHeader={
              showMembersHeader && index === firstMemberIndex
            }
            onSelect={() => command({ id: item.id, label: item.label })}
          />
        ))}
        {presentation.status !== "ready" && (
          <MentionStatus status={presentation.status} hasItems={items.length > 0} />
        )}
      </div>
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
  useEffect(() => {
    scrollSelectedRowIntoView(listRef.current)
  }, [selectedIndex, geometry])
  if (!geometry || !visible || !command) return null

  const spansMultipleServers = items.some(
    (item) => item.serverId !== items[0]?.serverId,
  )
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
      <div
        ref={listRef}
        className="relative overflow-x-hidden overflow-y-auto thin-scrollbar"
        style={{ maxHeight: "var(--anchored-popover-max-height)" }}
      >
        {items.map((item, index) => (
          <ChannelRefRow
            key={item.id}
            item={item}
            selected={index === selectedIndex}
            showServerPrefix={spansMultipleServers}
            onSelect={() => command(toChannelRefCommandProps(item))}
          />
        ))}
        {presentation && presentation.status !== "ready" && (
          <ChannelRefStatus status={presentation.status} />
        )}
      </div>
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

function ChannelRefRow({
  item,
  selected,
  showServerPrefix,
  onSelect,
}: {
  item: ChannelRefCandidate
  selected: boolean
  showServerPrefix: boolean
  onSelect: () => void
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
        onSelect()
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
}

function MentionRow({
  item,
  selected,
  showMembersHeader,
  onSelect,
}: {
  item: MentionItem
  selected: boolean
  showMembersHeader: boolean
  onSelect: () => void
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
          onSelect()
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
}
