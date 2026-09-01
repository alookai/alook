"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { displayName } from "@/lib/community/display-name"
import type { Reaction } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import {
  type ReactionDetailsProfile,
  useReactionDetails,
} from "@/hooks/community/use-reaction-details"
import { useCommunityProfile } from "@/stores/community/ws"
import {
  HorizontalOverflowFadeOverlays,
  useHorizontalOverflowRail,
} from "../horizontal-overflow-rail"
import { MemberIdentityRow } from "../members/member-identity-row"

const HOLD_MS = 450
const MOVE_TOLERANCE_PX = 10

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

function ReactionMemberRow({
  userId,
  authorizedProfile,
}: {
  userId: string
  authorizedProfile: ReactionDetailsProfile | null | undefined
}) {
  const liveProfile = useCommunityProfile(authorizedProfile ? userId : null)
  const name = authorizedProfile ? (liveProfile?.name ?? authorizedProfile.name) : "Unknown member"
  return (
    <li data-testid={tid.reactionMember(userId)} className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-2">
      <MemberIdentityRow
        name={name}
        discriminator={authorizedProfile ? (liveProfile?.discriminator ?? authorizedProfile.discriminator) : undefined}
        avatarLabel={name}
        avatarSeed={authorizedProfile ? userId : undefined}
        avatarSrc={authorizedProfile ? (liveProfile?.avatar ?? authorizedProfile.avatar) : undefined}
        ringColor="var(--popover)"
      />
    </li>
  )
}

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
  const actors = new Map(details.data?.actors.map((actor) => [actor.userId, actor]))
  const reactionRailKey = reactions.map((reaction) => `${reaction.emoji}\0${reaction.count}`).join("\0")
  const {
    fades: reactionFades,
    onKeyDown: onReactionRailKeyDown,
    onScroll: onReactionRailScroll,
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
      className="flex max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] flex-col gap-3 overflow-hidden transition-none sm:max-w-sm **:data-[slot=dialog-close]:size-11 **:data-[slot=dialog-close]:transition-none sm:**:data-[slot=dialog-close]:size-7"
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
              onScroll={onReactionRailScroll}
              onKeyDown={onReactionRailKeyDown}
              className="h-11! min-h-11 w-full max-w-full flex-nowrap gap-1 overflow-x-auto overflow-y-hidden rounded-none bg-transparent! p-0! overscroll-x-contain thin-scrollbar scrollbar-none"
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
                  className="h-11! min-h-11 min-w-11 data-active:bg-accent! data-active:text-foreground! after:hidden"
                >
                  <span aria-hidden="true">{reaction.emoji}</span>
                  <span>{reaction.count}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <HorizontalOverflowFadeOverlays
              fades={reactionFades}
              leftTestId={tid.reactionFadeLeft(messageId)}
              rightTestId={tid.reactionFadeRight(messageId)}
              surface="popover"
            />
          </div>
        </Tabs>
      )}

      <div
        id={`${tid.reactionDialog(messageId)}-panel`}
        role="tabpanel"
        aria-labelledby={selectedEmoji ? tid.reactionTab(selectedEmoji) : undefined}
        className="min-h-28 flex-auto overflow-y-auto thin-scrollbar"
        aria-live="polite"
      >
        {details.isLoading ? (
          <div className="space-y-2 py-2" aria-label="Loading reactions">
            {[0, 1, 2].map((index) => <div key={index} className="h-11 animate-pulse rounded-lg bg-muted" />)}
          </div>
        ) : selectedReaction?.userIds.length ? (
          <ul>
            {selectedReaction.userIds.map((userId) => (
              <ReactionMemberRow
                key={userId}
                userId={userId}
                authorizedProfile={actors.get(userId)?.profile}
              />
            ))}
          </ul>
        ) : (
          <p data-testid={tid.reactionEmpty(messageId)} className="py-8 text-center text-sm text-muted-foreground">
            No reactions yet
          </p>
        )}
      </div>
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
  const [open, setOpen] = useState(false)
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null)

  useEffect(() => {
    const previous = previousEmojisRef.current
    setSelectedEmoji((selected) => reconcileReactionSelection(previous, emojis, selected))
    previousEmojisRef.current = emojis
  }, [emojis])

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
          const tooltipNames = reaction.userIds?.length
            ? reaction.userIds.map((id) => resolveUserName?.(id) ?? displayName(null)).join(", ")
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
            restoreReactionFocus(initiatingChipRef.current, reactionGroupRef.current)
          }
        }}
      >
        <ReactionDetailsDialog
          open={open}
          messageId={messageId}
          authorName={authorName}
          messagePreview={messagePreview || "Message"}
          reactions={reactions}
          selectedEmoji={selectedEmoji}
          onSelectedEmojiChange={setSelectedEmoji}
        />
      </Dialog>
    </>
  )
}
