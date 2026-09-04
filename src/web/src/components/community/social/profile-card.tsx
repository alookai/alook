"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Bot, MessagesSquare, Shield, UserRound } from "lucide-react"
import { BOT_ACTIVITY_PRESETS } from "@alook/shared"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Avatar } from "../avatar"
import { SeededBackdrop } from "@/components/avatar"
import { resolveAvatar } from "@/lib/avatar/resolve"
import { StatusEditor, hasStatus } from "./status-editor"
import type {
  OwnerProfileRef,
  Profile,
} from "@/components/community/social/profile-types"
import type { Breakpoint } from "@/hooks/use-mobile"
import { useCommunityProfile } from "@/stores/community/ws"
import { avatarInitial } from "@/lib/community/avatar"
import { tid } from "@/lib/community/testids"
import { communityWsInterruptAgent } from "@/hooks/community/use-community-ws"
import { isBotActivityActive, isBotActivityRunning } from "./bot-audit-preview"
import { BotMarkSticker } from "./bot-mark-sticker"

// Live cards resolve status from the global profile map. Seed props are used
// only by static, id-less showcase cards.
export function resolveCardStatus(
  overlay: {
    statusEmoji?: string | null
    statusText?: string | null
  } | undefined,
  seedEmoji: string | null | undefined,
  seedText: string | null | undefined,
): { emoji: string | null; text: string | null } {
  if (overlay) {
    return {
      emoji: overlay.statusEmoji ?? null,
      text: overlay.statusText ?? null,
    }
  }
  return { emoji: seedEmoji ?? null, text: seedText ?? null }
}

export function resolveProfileBackdropSeed(
  avatar: string | null | undefined,
  userId: string | null | undefined,
  name: string,
): string {
  const fallbackSeed = userId ?? name
  const resolved = resolveAvatar(avatar, fallbackSeed)
  return resolved.kind === "beam" ? resolved.seed : fallbackSeed
}

export function displayOwnerHandle(handle: string): string {
  return handle.replace(/#\d+$/, "")
}

export type AuditPreviewPlacement = "right" | "left" | "top" | "bottom"

type RectLike = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">

export function resolveAuditPreviewPlacement({
  card,
  preview,
  viewportWidth,
  viewportHeight,
  gap = 8,
}: {
  card: RectLike
  preview: Pick<RectLike, "width" | "height">
  viewportWidth: number
  viewportHeight: number
  gap?: number
}): AuditPreviewPlacement {
  const room = {
    right: viewportWidth - card.right,
    left: card.left,
    top: card.top,
    bottom: viewportHeight - card.bottom,
  }
  const sideCrossAxisFits = preview.height <= viewportHeight - gap * 2
  const verticalCrossAxisFits = preview.width <= viewportWidth - gap * 2

  if (sideCrossAxisFits && room.right >= preview.width + gap) return "right"
  if (sideCrossAxisFits && room.left >= preview.width + gap) return "left"
  if (verticalCrossAxisFits && room.top >= preview.height + gap) return "top"
  if (verticalCrossAxisFits && room.bottom >= preview.height + gap) return "bottom"

  return (Object.entries(room) as Array<[AuditPreviewPlacement, number]>)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "right"
}

type AuditPreviewPosition = {
  placement: AuditPreviewPlacement
  left: number | string
  top: number
  height?: number
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return value
  return Math.min(Math.max(value, min), max)
}

function useAuditPreviewPosition(enabled: boolean, x: number, y: number) {
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<AuditPreviewPosition>({
    placement: "right",
    left: "calc(100% + 0.5rem)",
    top: 0,
  })

  useLayoutEffect(() => {
    if (!enabled) return

    let frame = 0
    const update = () => {
      const cardElement = cardRef.current
      const previewElement = previewRef.current
      if (!cardElement || !previewElement) return
      const transformedCard = cardElement.getBoundingClientRect()
      const card = {
        top: transformedCard.top,
        right: transformedCard.left + cardElement.offsetWidth,
        bottom: transformedCard.top + cardElement.offsetHeight,
        left: transformedCard.left,
        width: cardElement.offsetWidth,
        height: cardElement.offsetHeight,
      }
      const preview = {
        width: previewElement.offsetWidth,
        height: previewElement.offsetHeight,
      }
      const gap = 8
      const margin = 8
      const placement = resolveAuditPreviewPlacement({
        card,
        preview,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap,
      })

      const verticalOffset = clamp(
        0,
        margin - card.top,
        window.innerHeight - margin - preview.height - card.top,
      )
      const horizontalOffset = clamp(
        card.width - preview.width,
        margin - card.left,
        window.innerWidth - margin - preview.width - card.left,
      )
      const next: AuditPreviewPosition = placement === "right"
        ? { placement, left: card.width + gap, top: verticalOffset, height: card.height }
        : placement === "left"
          ? { placement, left: -preview.width - gap, top: verticalOffset, height: card.height }
          : placement === "top"
            ? { placement, left: horizontalOffset, top: -preview.height - gap, height: card.height }
            : { placement, left: horizontalOffset, top: card.height + gap, height: card.height }

      setPosition((current) => current.placement === next.placement
        && current.left === next.left
        && current.top === next.top
        && current.height === next.height
        ? current
        : next)
    }

    update()
    frame = requestAnimationFrame(update)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    const popoverElement = popoverRef.current
    popoverElement?.addEventListener("animationend", update)
    popoverElement?.addEventListener("animationcancel", update)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    if (cardRef.current) observer?.observe(cardRef.current)
    if (previewRef.current) observer?.observe(previewRef.current)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
      popoverElement?.removeEventListener("animationend", update)
      popoverElement?.removeEventListener("animationcancel", update)
      observer?.disconnect()
    }
  }, [enabled, x, y])

  return { popoverRef, cardRef, previewRef, position }
}

// Profile card — popover anchored at the click point on desktop, bottom sheet on mobile.
// Identity, about, status, and presence are read from the global profile map
// whenever a userId is present. Static cards use their supplied display data.
export function ProfileCard({ data, x, y, bp, onClose, onMessage, isSelf, onUpdateStatus, onOpenOwnerProfile, onOpenBotAudit, initialStatusEmoji, initialStatusText, activityStatusEmoji, activityStatusText, embedded }: {
  data: Profile
  x: number
  y: number
  bp: Breakpoint
  onClose: () => void
  onMessage?: (userId: string, text: string) => void
  isSelf?: boolean
  // Only used when `isSelf` — the inline status row opens `StatusEditor` and
  // calls this on a preset pick / free-text commit / emoji override / clear.
  onUpdateStatus?: (emoji: string | null, text: string | null) => void
  onOpenOwnerProfile?: (owner: OwnerProfileRef) => void
  onOpenBotAudit?: (botId: string) => void
  initialStatusEmoji?: string | null
  initialStatusText?: string | null
  activityStatusEmoji?: string | null
  activityStatusText?: string | null
  // Static card surface for contexts such as product previews. The regular
  // profile interaction still uses the anchored popover / mobile sheet.
  embedded?: boolean
}) {
  const [msg, setMsg] = useState("")
  const [open, setOpen] = useState(true)
  const [interruptPending, setInterruptPending] = useState(false)
  const mobile = bp === "mobile"
  const globalProfile = useCommunityProfile(data.userId)
  const liveStatus = data.userId
    ? {
        statusEmoji: globalProfile?.statusEmoji,
        statusText: globalProfile?.statusText,
      }
    : undefined
  const { emoji: statusEmoji, text: statusText } = resolveCardStatus(liveStatus, initialStatusEmoji, initialStatusText)
  const activityStatus = resolveCardStatus(liveStatus, activityStatusEmoji, activityStatusText)
  const activityIdle = activityStatus.emoji === BOT_ACTIVITY_PRESETS.idle.emoji
    && activityStatus.text === BOT_ACTIVITY_PRESETS.idle.text
  useEffect(() => {
    if (!interruptPending) return
    if (activityIdle) {
      setInterruptPending(false)
      return
    }
    const timer = globalThis.setTimeout(() => setInterruptPending(false), 10_000)
    return () => globalThis.clearTimeout(timer)
  }, [activityIdle, interruptPending])
  const name = data.userId ? (globalProfile?.name ?? "Unknown") : (data.name ?? "Unknown")
  const avatar = data.userId
    ? (globalProfile?.avatar ?? avatarInitial(name))
    : (data.avatar ?? avatarInitial(name))
  const discriminator = data.userId ? globalProfile?.discriminator : data.discriminator
  const about = data.userId ? globalProfile?.aboutMe : data.about
  const presence = data.userId ? (globalProfile?.presence ?? "offline") : data.presence
  const mutual = data.mutual ?? 0
  const botIdentity = data.identity?.kind === "bot" ? data.identity : null
  const showOwnedBotCard = Boolean(botIdentity?.ownedByViewer && data.userId)
  const { popoverRef, cardRef, previewRef, position: previewPosition } = useAuditPreviewPosition(
    showOwnedBotCard && !mobile && !embedded,
    x,
    y,
  )
  const backdropSeed = resolveProfileBackdropSeed(avatar, data.userId, name)
  const close = () => setOpen(false)
  const send = () => {
    const text = msg.trim()
    if (!text || !data.userId) return
    onMessage?.(data.userId, text)
    setMsg("")
    if (mobile) onClose()
    else close()
  }
  const interruptAgent = () => {
    if (!data.userId || interruptPending) return
    setInterruptPending(true)
    communityWsInterruptAgent(data.userId)
  }
  const card = (
    <>
      <div className="relative -m-2 mb-0 h-16 overflow-hidden rounded-t-lg">
        <SeededBackdrop seed={backdropSeed} />
      </div>
      <div className="px-2 pb-2">
        {/* `pl-4` — the card body below has its own `p-4`, so its text sits
            16px in from this row's container; without matching padding here
            the avatar (flush left) reads as un-aligned with the name/bio
            under it. */}
        <div className="-mt-10 mb-2 flex pl-4">
          {/* `size=77` (64 * 1.2), `ring-[5px]` (round(77*0.0625), matching
              `avatar.tsx`'s own dot-ring formula so the frame keeps the
              same ratio it had at 64px), `-mt-10` (~half of 77, rounded to
              the nearest Tailwind step) keeps the same banner-overlap
              proportion the 64px avatar had at `-mt-8`. */}
          <div className="relative">
            <div className="rounded-full ring-[5px] ring-popover">
              <Avatar label={avatar} seed={data.userId} size={77} presence={presence} ringColor="var(--popover)" />
            </div>
            {/* Status sits on the same row as the presence dot, just to its
                right, instead of floating over the avatar's corner. The dot
                (`avatar.tsx`'s `AvatarBadge`) is `absolute right-0 bottom-0`
                sized to `size*0.22` — at `size=77` that's a 17px dot flush
                with the avatar's bottom-right corner, so its vertical
                center sits at `77 - 17/2 = 68.5px` from the avatar's top.
                `top-[68.5px] -translate-y-1/2` centers the pill on that
                same line; `left-full ml-2` starts it 8px past the avatar's
                (and therefore the dot's) right edge. */}
            {isSelf ? (
              <StatusEditor
                emoji={statusEmoji}
                text={statusText}
                onChange={(emoji, text) => onUpdateStatus?.(emoji, text)}
                side="bottom"
                align="start"
              >
                {/* `border-border` gives the pill a defined edge — `bg-secondary`
                    alone is only ~6% lighter than the popover behind it (see
                    globals.css dark-mode tokens), which read as nearly invisible.
                    `shadow-(--e1)` lifts it off the banner it now overlaps.
                    `max-w-32 truncate` — the pill's containing block for
                    `max-w` purposes is this small avatar-sized wrapper, not
                    the card, so it needs its own explicit cap rather than
                    `max-w-full`. `px-2 py-0.5` (tighter than the original
                    `px-2.5 py-1`) keeps the pill itself compact; emoji and
                    term are split into separate spans under the row's
                    `gap-2` (instead of one text node with a plain space)
                    so the space between *them* can be tuned independently
                    of the pill's outer padding. `whitespace-nowrap` — this
                    box only sets `left` (no `right`), and its containing
                    block (the 77px avatar wrapper) is narrower than `left`
                    itself, so the browser's shrink-to-fit width calc has
                    ~0px of "available width" to work with and falls back to
                    min-content — i.e. wraps at every word — without an
                    explicit no-wrap. `title` — native tooltip so a
                    `truncate`-clipped term is still readable on hover,
                    without wrestling `StatusEditor`'s `PopoverTrigger
                    render={children}` (which clones this exact element) or
                    nesting an interactive `Tooltip.Trigger` inside a
                    `<button>` that's already a trigger for something else. */}
                <button title={statusText || undefined} className="absolute left-full top-[68.5px] ml-2 flex max-w-32 -translate-y-1/2 items-center gap-2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[13px] whitespace-nowrap text-secondary-foreground shadow-(--e1) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {hasStatus(statusEmoji, statusText) ? (
                    <>
                      {statusEmoji && <span>{statusEmoji}</span>}
                      {statusText && <span className="min-w-0 truncate">{statusText}</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Set a status</span>
                  )}
                </button>
              </StatusEditor>
            ) : (
              hasStatus(statusEmoji, statusText) && (
                <div data-testid={tid.statusPill} title={statusText || undefined} className="absolute left-full top-[68.5px] ml-2 flex max-w-32 -translate-y-1/2 items-center gap-2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[13px] whitespace-nowrap text-secondary-foreground shadow-(--e1)">
                  {statusEmoji && <span>{statusEmoji}</span>}
                  {statusText && <span className="min-w-0 truncate">{statusText}</span>}
                </div>
              )
            )}
          </div>
        </div>
        <div className="rounded-lg bg-card p-4">
          <div className="flex min-w-0 items-baseline text-xl font-semibold leading-tight tracking-[-0.015em]">
            <span className="min-w-0 truncate">{name}</span>
            {discriminator && (
              <span className="ml-1.5 shrink-0 text-sm font-normal tracking-wide text-muted-foreground">
                #{discriminator}
              </span>
            )}
          </div>
          {/* Bio reads directly under the name, no shouty label — it isn't
              the card's focal point, so it doesn't need a header announcing
              it. Role + mutual-server count are lower-priority context, so
              they move down here too, as one quiet caption row — `mt-6`
              (not `mt-4`) so the gap reads unambiguously as a group boundary
              (a step past DESIGN.md's 16px between-groups token) rather than
              just tighter line spacing off the bio above it. */}
          <p className="mt-2 text-[15px] text-muted-foreground">{about || "No bio yet."}</p>
          {(botIdentity || data.contextLabel || mutual > 0) && (
            <div className="mt-6 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {botIdentity && (
                <>
                  <Badge
                    data-testid={tid.profileBotBadge}
                    variant="secondary"
                    className="h-5 gap-1 text-xs"
                  >
                    <Bot className="size-3 shrink-0" aria-hidden />
                    Bot
                  </Badge>
                  <button
                    type="button"
                    data-testid={tid.profileOwnerLink}
                    className="group/owner flex h-11 min-w-0 max-w-full items-center rounded-full text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-5"
                    onClick={() => onOpenOwnerProfile?.(botIdentity.ownerProfile)}
                    aria-label={`Open owner profile @${botIdentity.ownerProfile.handle}`}
                  >
                    <Badge
                      variant="secondary"
                      className="pointer-events-none min-w-0 max-w-full transition-colors group-hover/owner:bg-accent group-active/owner:bg-accent/80"
                    >
                      <UserRound className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">@{displayOwnerHandle(botIdentity.ownerProfile.handle)}</span>
                    </Badge>
                  </button>
                </>
              )}
              {data.contextLabel && (
                <Badge data-testid={tid.profileContextBadge} variant="secondary" className="h-5 gap-1 text-xs">
                  <Shield className="size-3" /> {data.contextLabel}
                </Badge>
              )}
              {mutual > 0 && <span>{mutual} mutual server{mutual > 1 ? "s" : ""}</span>}
            </div>
          )}
          {!isSelf && (
            <div className="mt-4 flex h-9 items-center gap-2 rounded-md bg-secondary px-2">
              <input
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return
                  send()
                }}
                className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
                placeholder={`Message @${name}`}
              />
              <button
                onClick={send}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label="Send message"
              >
                <MessagesSquare className="size-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )

  const secondaryCards = showOwnedBotCard && data.userId ? (
    <BotMarkSticker
      botId={data.userId}
      active={isBotActivityActive(activityStatus.emoji, activityStatus.text)}
      showStop={isBotActivityRunning(activityStatus.emoji, activityStatus.text)
        || (interruptPending && !activityIdle)}
      stopPending={interruptPending}
      onStop={interruptAgent}
      onOpenActivity={() => onOpenBotAudit?.(data.userId!)}
    />
  ) : null

  if (embedded)
    return (
      <div className="flex w-full flex-col gap-2">
        {secondaryCards}
        <div data-testid={tid.profileCard} className="w-full overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-(--e2)">{card}</div>
      </div>
    )

  if (mobile)
    return (
      <Sheet
        open={open}
        onOpenChange={(nowOpen) => {
          setOpen(nowOpen)
          if (!nowOpen) onClose()
        }}
        modal
      >
        <SheetContent
          side="bottom"
          showOverlay
          showCloseButton={false}
          className="data-[side=bottom]:border-t-0 bg-transparent p-3 shadow-none"
        >
          <SheetTitle className="sr-only">{name} profile</SheetTitle>
          <SheetClose className="sr-only">Close profile</SheetClose>
          <div className="flex flex-col gap-2">
            {secondaryCards}
            <div data-testid={tid.profileCard} className="overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-(--e2)">{card}</div>
          </div>
        </SheetContent>
      </Sheet>
    )

  // desktop: shadcn Popover anchored to an invisible trigger at the click point
  return (
    <Popover open={open} onOpenChange={setOpen} onOpenChangeComplete={(nowOpen) => { if (!nowOpen) onClose() }}>
      <PopoverTrigger
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed size-0"
        style={{ left: x, top: y }}
      />
      <PopoverContent ref={popoverRef} side="right" align="start" sideOffset={8} className="relative w-75 overflow-visible border-0 bg-transparent p-0 shadow-none">
        {secondaryCards && (
          <div
            ref={previewRef}
            data-testid={tid.botAuditPreviewDock}
            data-placement={previewPosition.placement}
            className="absolute w-full"
            style={{
              left: previewPosition.left,
              top: previewPosition.top,
              height: previewPosition.height,
            }}
          >
            {secondaryCards}
          </div>
        )}
        <div ref={cardRef} data-testid={tid.profileCard} className="overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-(--e2)">
          {card}
        </div>
      </PopoverContent>
    </Popover>
  )
}
