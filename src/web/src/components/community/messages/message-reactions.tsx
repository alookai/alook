"use client"

import { Smile } from "@/components/icons/lucide"
import { EmptyState } from "../empty-state"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useVirtualizer } from "@tanstack/react-virtual"
import { memo, useEffect, useMemo, useRef } from "react"
import type React from "react"
import { NumberTicker } from "@/components/ui/number-ticker"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { displayName } from "@/lib/community/display-name"
import type { Reaction } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  type ReactionDetailsProfile,
  useReactionDetails,
} from "@/hooks/community/use-reaction-details"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS, measureCommunityVirtualizerElement, observeCommunityVirtualizerRect } from "@/hooks/community/virtualizer-react-options"
import {
  useHorizontalOverflowRail,
} from "@/components/horizontal-overflow-rail"
import { MemberIdentityRow } from "../members/member-identity-row"

const HOLD_MS = 450
const MOVE_TOLERANCE_PX = 10
const MAX_REACTION_TOOLTIP_NAMES = 10
const REACTION_ROW_ESTIMATE_PX = 48

function formatReactionTooltipNames(
  reaction: Pick<Reaction, "count" | "userIds">,
  resolveUserName?: (userId: string) => string,
): string | undefined {
  const userIds = reaction.userIds ?? []
  const total = Math.max(reaction.count, userIds.length)
  if (total === 0) return undefined
  const sampleIds = userIds.slice(0, MAX_REACTION_TOOLTIP_NAMES)
  const names = sampleIds.map((id) => resolveUserName?.(id) ?? displayName(null))
  const remaining = total - names.length
  if (names.length === 0) {
    return `${total} ${total === 1 ? "person" : "people"}`
  }
  if (remaining > 0) {
    return `${names.join(", ")} and ${remaining} ${remaining === 1 ? "other" : "others"}`
  }
  return names.join(", ")
}

export function reconcileReactionSelection(
  previousEmojis: readonly string[],
  nextEmojis: readonly string[],
  selectedEmoji: string | null,
): string | null {
  if (nextEmojis.length === 0) return null
  if (selectedEmoji && nextEmojis.includes(selectedEmoji)) return selectedEmoji
  const previousIndex = selectedEmoji ? previousEmojis.indexOf(selectedEmoji) : 0
  const neighborIndex = previousIndex < 0 ? 0 : Math.min(previousIndex, nextEmojis.length - 1)
  return nextEmojis[neighborIndex] ?? null
}

const ReactionMemberRow = memo(function ReactionMemberRow({
  userId,
  authorizedProfile,
  style,
}: {
  userId: string
  authorizedProfile: ReactionDetailsProfile | null | undefined
  style?: React.CSSProperties
}) {
  const name = authorizedProfile ? authorizedProfile.name : "Member unavailable"
  return (
    <li
      data-testid={tid.reactionMember(userId)}
      style={style}
      className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-2"
    >
      <MemberIdentityRow
        name={name}
        discriminator={authorizedProfile ? authorizedProfile.discriminator : undefined}
        avatarLabel={name}
        avatarSeed={authorizedProfile ? userId : undefined}
        avatarSrc={authorizedProfile ? authorizedProfile.avatar : undefined}
        ringColor="var(--popover)"
      />
    </li>
  )
})

function ReactionChip({
  messageId,
  reaction,
  hoverCapable,
  tooltipActive,
  tooltipNames,
  onToggle,
  onOpen,
}: {
  messageId: string
  reaction: Reaction
  hoverCapable: boolean
  tooltipActive: boolean
  tooltipNames?: string
  onToggle?: (emoji: string) => void
  onOpen: (emoji: string, button: HTMLButtonElement) => void
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const suppressClickRef = useRef(false)
  const coarsePointer = (pointerType: string) =>
    !hoverCapable && (pointerType === "touch" || pointerType === "pen")

  const clearHold = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }
  useEffect(() => clearHold, [])

  const chip = (
    <button
      ref={buttonRef}
      type="button"
      data-testid={tid.reactionChip(messageId, reaction.emoji)}
      data-message-reaction={reaction.emoji}
      aria-label={`${reaction.emoji}, ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}, ${reaction.me ? "you reacted" : "you have not reacted"}. Press to toggle${hoverCapable ? "" : "; long press for details"}`}
      aria-pressed={reaction.me}
      aria-haspopup={hoverCapable ? undefined : "dialog"}
      className={[
        "flex h-6 touch-pan-y select-none items-center gap-1 rounded-md px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [-webkit-touch-callout:none]",
        reaction.me ? "border border-primary/50 bg-accent" : "bg-secondary",
      ].join(" ")}
      onPointerDown={(event) => {
        if (!coarsePointer(event.pointerType)) return
        event.stopPropagation()
        clearHold()
        suppressClickRef.current = false
        startRef.current = { x: event.clientX, y: event.clientY }
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          suppressClickRef.current = true
          const button = buttonRef.current
          if (button) onOpen(reaction.emoji, button)
        }, HOLD_MS)
      }}
      onPointerMove={(event) => {
        const start = startRef.current
        if (!start || !coarsePointer(event.pointerType)) return
        event.stopPropagation()
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) {
          clearHold()
          startRef.current = null
          suppressClickRef.current = true
        }
      }}
      onPointerUp={() => {
        clearHold()
        startRef.current = null
      }}
      onPointerLeave={(event) => {
        if (!coarsePointer(event.pointerType) || !startRef.current) return
        clearHold()
        startRef.current = null
        suppressClickRef.current = true
      }}
      onPointerCancel={() => {
        clearHold()
        startRef.current = null
        suppressClickRef.current = true
      }}
      onContextMenu={(event) => {
        if (!hoverCapable) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault()
          onOpen(reaction.emoji, event.currentTarget)
        }
      }}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          event.preventDefault()
          event.stopPropagation()
          return
        }
        onToggle?.(reaction.emoji)
      }}
    >
      <span aria-hidden="true">{reaction.emoji}</span>
      <NumberTicker value={reaction.count} className="text-xs text-muted-foreground" />
    </button>
  )

  if (!hoverCapable || !tooltipActive || !tooltipNames) return chip
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>Reacted by {tooltipNames}</TooltipContent>
    </Tooltip>
  )
}

function ReactionDetailsDialog({
  open,
  messageId,
  authorName,
  messagePreview,
  reactions,
  selectedEmoji,
  onSelectedEmojiChange,
}: {
  open: boolean
  messageId: string
  authorName: string
  messagePreview: string
  reactions: readonly Reaction[]
  selectedEmoji: string | null
  onSelectedEmojiChange: (emoji: string) => void
}) {
  const userIds = useMemo(
    () => reactions.flatMap((reaction) => reaction.userIds ?? []),
    [reactions],
  )
  const details = useReactionDetails({ messageId, open, userIds })
  const selectedReaction = reactions.find((reaction) => reaction.emoji === selectedEmoji)
  const reactorIds = useMemo(() => selectedReaction?.userIds ?? [], [selectedReaction?.userIds])
  const actors = useMemo(
    () => new Map(details.data?.actors.map((actor) => [actor.userId, actor])),
    [details.data?.actors],
  )
  const listViewportRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const reactorVirtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    measureElement: measureCommunityVirtualizerElement,
    observeElementRect: observeCommunityVirtualizerRect,
    count: reactorIds.length,
    getScrollElement: () => listViewportRef.current,
    estimateSize: () => REACTION_ROW_ESTIMATE_PX,
    overscan: 6,
    initialRect: { width: 320, height: 320 },
  })
  const reactionRailKey = reactions.map((reaction) => `${reaction.emoji}\0${reaction.count}`).join("\0")
  const {
    onKeyDown: onReactionRailKeyDown,
    scrollerRef: reactionScrollerRef,
    selectedRef: selectedReactionRef,
  } = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
    contentKey: reactionRailKey,
    selectedKey: selectedEmoji,
    preserveChildKeyboard: true,
  })

  return (
    <DialogContent
      data-testid={tid.reactionDialog(messageId)}
      finalFocus={false}
      className="flex max-h-[calc(100%-2rem)] flex-col gap-3 overflow-hidden transition-none sm:max-w-sm **:data-[slot=dialog-close]:size-11 **:data-[slot=dialog-close]:transition-none sm:**:data-[slot=dialog-close]:size-7"
    >
      <DialogHeader className="min-w-0 shrink-0">
        <DialogTitle className="truncate pr-8">{authorName}</DialogTitle>
        <DialogDescription className="truncate" title={messagePreview}>{messagePreview}</DialogDescription>
      </DialogHeader>

      {reactions.length > 0 && selectedEmoji && (
        <Tabs className="shrink-0" value={selectedEmoji} onValueChange={onSelectedEmojiChange}>
          <div className="relative min-w-0">
            <TabsList
              ref={reactionScrollerRef}
              variant="line"
              data-testid={tid.reactionScroller(messageId)}
              aria-label="Reaction types"
              onKeyDown={onReactionRailKeyDown}
              className="h-11! min-h-11 w-full max-w-full flex-nowrap gap-1 overflow-x-auto overflow-y-hidden rounded-none bg-transparent! px-4! py-0! overscroll-x-contain scroll-fade-x scroll-fade-4 scroll-px-4 scrollbar-none"
            >
              {reactions.map((reaction) => (
                <TabsTrigger
                  key={reaction.emoji}
                  ref={selectedEmoji === reaction.emoji ? selectedReactionRef : undefined}
                  value={reaction.emoji}
                  id={tid.reactionTab(reaction.emoji)}
                  data-testid={tid.reactionTab(reaction.emoji)}
                  aria-label={`${reaction.emoji}, ${reaction.count}`}
                  aria-controls={`${tid.reactionDialog(messageId)}-panel`}
                  className="h-11! min-h-11 min-w-11 data-active:bg-accent! data-active:text-foreground! after:hidden focus-visible:ring-inset focus-visible:-outline-offset-1"
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span>{reaction.count}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      )}

      <ScrollArea
        viewportRef={listViewportRef}
        className="flex min-h-28 flex-auto flex-col"
        viewportClassName="min-h-0 flex-1"
        contentClassName="min-h-full"
        viewportProps={{
          id: `${tid.reactionDialog(messageId)}-panel`,
          role: "tabpanel",
          "aria-labelledby": selectedEmoji ? tid.reactionTab(selectedEmoji) : undefined,
          "aria-live": "polite",
        }}
      >
        {details.isLoading ? (
          <div className="space-y-2 py-2" aria-label="Loading reactions">
            {[0, 1, 2].map((index) => <div key={index} className="h-11 animate-pulse rounded-lg bg-muted" />)}
          </div>
        ) : reactorIds.length > 0 ? (
          <ul
            ref={reactorVirtualizer.containerRef}
            className="relative w-full"
            style={{ height: reactorVirtualizer.getTotalSize() }}
          >
            {reactorVirtualizer.getVirtualItems().map((virtualRow) => {
              const userId = reactorIds[virtualRow.index]!
              return (
                <ReactionMemberRow
                  key={userId}
                  userId={userId}
                  authorizedProfile={actors.get(userId)?.profile}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                />
              )
            })}
          </ul>
        ) : (
          <div data-testid={tid.reactionEmpty(messageId)} className="flex min-h-full flex-col"><EmptyState icon={Smile} label="No reactions yet" /></div>
        )}
      </ScrollArea>
    </DialogContent>
  )
}

export function resolveReactionFinalFocus(
  initiatingChip: HTMLButtonElement | null,
  reactionGroup: HTMLDivElement | null,
): HTMLElement | null {
  return initiatingChip?.isConnected ? initiatingChip : reactionGroup
}

export function restoreReactionFocus(
  initiatingChip: HTMLButtonElement | null,
  reactionGroup: HTMLDivElement | null,
): HTMLElement | null {
  const target = resolveReactionFinalFocus(initiatingChip, reactionGroup)
  target?.focus({ preventScroll: true })
  return target
}

export function MessageReactions({
  messageId,
  authorName,
  messagePreview,
  reactions,
  hoverCapable,
  tooltipActive,
  onToggleReaction,
  resolveUserName,
  trailingControl,
}: {
  messageId: string
  authorName: string
  messagePreview: string
  reactions: readonly Reaction[]
  hoverCapable: boolean
  tooltipActive: boolean
  onToggleReaction?: (emoji: string) => void
  resolveUserName?: (userId: string) => string
  trailingControl?: React.ReactNode
}) {
  const emojis = useMemo(() => reactions.map((reaction) => reaction.emoji), [reactions])
  const previousEmojisRef = useRef(emojis)
  const initiatingChipRef = useRef<HTMLButtonElement | null>(null)
  const reactionGroupRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useAtom(useCreateAtom(false))
  const [dialogMounted, setDialogMounted] = useAtom(useCreateAtom(false))
  const [selectedEmoji, setSelectedEmoji] = useAtom(useCreateAtom<string | null>(null))

  useEffect(() => {
    const previous = previousEmojisRef.current
    setSelectedEmoji((selected) => reconcileReactionSelection(previous, emojis, selected))
    previousEmojisRef.current = emojis
  }, [emojis, setSelectedEmoji])

  return (
    <>
      <div
        ref={reactionGroupRef}
        data-testid={tid.reactionGroup(messageId)}
        className="flex flex-wrap gap-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        tabIndex={-1}
        aria-label="Message reactions"
      >
        {reactions.map((reaction) => {
          const tooltipNames = hoverCapable && tooltipActive
            ? formatReactionTooltipNames(reaction, resolveUserName)
            : undefined
          return (
            <ReactionChip
              key={reaction.emoji}
              messageId={messageId}
              reaction={reaction}
              hoverCapable={hoverCapable}
              tooltipActive={tooltipActive}
              tooltipNames={tooltipNames}
              onToggle={onToggleReaction}
              onOpen={(emoji, button) => {
                initiatingChipRef.current = button
                setSelectedEmoji(emoji)
                setDialogMounted(true)
                setOpen(true)
              }}
            />
          )
        })}
        {trailingControl}
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(nextOpen) => {
          if (!nextOpen) {
            setDialogMounted(false)
            restoreReactionFocus(initiatingChipRef.current, reactionGroupRef.current)
          }
        }}
      >
        {(open || dialogMounted) && (
          <ReactionDetailsDialog
            open={open}
            messageId={messageId}
            authorName={authorName}
            messagePreview={messagePreview || "Message"}
            reactions={reactions}
            selectedEmoji={selectedEmoji}
            onSelectedEmojiChange={setSelectedEmoji}
          />
        )}
      </Dialog>
    </>
  )
}
