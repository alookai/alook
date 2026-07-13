"use client"

import { useState } from "react"
import { MessagesSquare, Shield } from "lucide-react"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Avatar } from "./avatar"
import { StatusEditor, hasStatus } from "./status-editor"
import type { Profile } from "./_types"
import type { Breakpoint } from "@/hooks/use-mobile"

// Deterministic, on-brand banner gradient. The seed is the owner's stable
// userId (falling back to name only when the id isn't yet resolved), so
// renaming never shifts the banner colour. Hue is constrained to the warm band
// (60–80 per DESIGN.md) and chroma kept low so two profiles always read as the
// same family — distinct but never garish.
export function generateGradient(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue1 = 60 + (Math.abs(hash) % 21)
  const hue2 = 60 + (Math.abs(hash * 7) % 21)
  return `linear-gradient(135deg, oklch(0.78 0.06 ${hue1}), oklch(0.68 0.05 ${hue2}))`
}

// Profile card — popover anchored at the click point on desktop, bottom sheet on mobile.
export function ProfileCard({ data, x, y, bp, onClose, onMessage, isSelf, onUpdateStatus }: {
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
}) {
  const [msg, setMsg] = useState("")
  const [open, setOpen] = useState(true)
  const mobile = bp === "mobile"
  const close = () => setOpen(false)
  const send = () => {
    const text = msg.trim()
    if (!text || !data.userId) return
    onMessage?.(data.userId, text)
    setMsg("")
    mobile ? onClose() : close()
  }
  const gradient = generateGradient(data.userId ?? data.name)
  const card = (
    <>
      {/* banner */}
      <div className="-m-2 mb-0 h-16 rounded-t-lg" style={{ background: gradient }} />
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
              <Avatar label={data.avatar} seed={data.userId} size={77} presence={data.presence} ringColor="var(--popover)" />
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
                emoji={data.statusEmoji ?? null}
                text={data.statusText ?? null}
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
                <button title={data.statusText || undefined} className="absolute left-full top-[68.5px] ml-2 flex max-w-32 -translate-y-1/2 items-center gap-2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[13px] whitespace-nowrap text-secondary-foreground shadow-(--e1) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {hasStatus(data.statusEmoji, data.statusText) ? (
                    <>
                      {data.statusEmoji && <span>{data.statusEmoji}</span>}
                      {data.statusText && <span className="min-w-0 truncate">{data.statusText}</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Set a status</span>
                  )}
                </button>
              </StatusEditor>
            ) : (
              hasStatus(data.statusEmoji, data.statusText) && (
                <div title={data.statusText || undefined} className="absolute left-full top-[68.5px] ml-2 flex max-w-32 -translate-y-1/2 items-center gap-2 rounded-full border border-border bg-secondary px-2 py-0.5 text-[13px] whitespace-nowrap text-secondary-foreground shadow-(--e1)">
                  {data.statusEmoji && <span>{data.statusEmoji}</span>}
                  {data.statusText && <span className="min-w-0 truncate">{data.statusText}</span>}
                </div>
              )
            )}
          </div>
        </div>
        <div className="rounded-lg bg-card p-4">
          <div className="text-xl font-semibold leading-tight tracking-[-0.015em]">
            {data.name}
            {data.discriminator && (
              <span className="ml-1.5 text-sm font-normal tracking-wide text-muted-foreground">
                #{data.discriminator}
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
          <p className="mt-2 text-[15px] text-muted-foreground">{data.about || "No bio yet."}</p>
          <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" className="h-5 gap-1 text-xs"><Shield className="size-3" /> {data.role}</Badge>
            {data.mutual > 0 && <span>{data.mutual} mutual server{data.mutual > 1 ? "s" : ""}</span>}
          </div>
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
                placeholder={`Message @${data.name}`}
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

  // mobile: bottom sheet (intentional mobile UX, kept manual)
  if (mobile)
    return (
      <div className="fixed inset-0 z-30 flex flex-col justify-end" onClick={onClose}>
        <div className="absolute inset-0 bg-foreground/30" />
        <div className="relative p-3" onClick={(e) => e.stopPropagation()}>
          <div className="overflow-hidden rounded-xl border border-border bg-popover p-2 shadow-(--e2)">{card}</div>
        </div>
      </div>
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
      <PopoverContent side="right" align="start" sideOffset={8} className="w-75 overflow-hidden p-2">
        {card}
      </PopoverContent>
    </Popover>
  )
}
