"use client"

import { SmilePlus } from "lucide-react"
import { EmojiPickerPopover } from "./emoji-picker"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { NumberTicker } from "@/components/ui/number-ticker"
import { displayName } from "@/lib/community/display-name"
import type { Reaction } from "./_types"

// Shared reaction-chip strip for both the interactive message row and the
// read-only thread opener. Parameterized on `interactive`:
//   - interactive (message.tsx): each chip is a <button> that toggles the
//     viewer's reaction, gains a "Reacted by …" tooltip once the row is
//     activated, and is followed by an add-reaction button. rounded-md.
//   - read-only (thread-opener.tsx): each chip is a <span>, no toggle, no
//     tooltip, no add button. rounded-full.
// `radius` is explicit so a caller can pick md vs full independent of mode.
export function ReactionChips({
  reactions,
  interactive,
  radius,
  activated,
  onToggleReaction,
  onReact,
  resolveUserName,
}: {
  reactions: Reaction[]
  interactive: boolean
  radius: "md" | "full"
  // Interactive-only: gates the per-chip tooltip and the add-reaction affordance
  // exactly as the message row did (bare chip until the row is activated).
  activated?: boolean
  onToggleReaction?: (emoji: string) => void
  onReact?: (emoji: string) => void
  resolveUserName?: (userId: string) => string
}) {
  const radiusClass = radius === "full" ? "rounded-full" : "rounded-md"

  if (!interactive) {
    return (
      <div className="mt-2 flex flex-wrap gap-1">
        {reactions.map((r, i) => (
          <span
            key={i}
            className={[
              "flex h-6 items-center gap-1 px-2 text-sm",
              radiusClass,
              r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
            ].join(" ")}
          >
            <span>{r.emoji}</span>
            <NumberTicker value={r.count} className="text-xs text-muted-foreground" />
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {reactions.map((r, i) => {
        const names = r.userIds?.length
          ? r.userIds.map((id) => resolveUserName?.(id) ?? displayName(null)).join(", ")
          : undefined
        const chip = (
          <button
            onClick={() => onToggleReaction?.(r.emoji)}
            className={[
              "flex h-6 items-center gap-1 px-2 text-sm",
              radiusClass,
              r.me ? "border border-primary/50 bg-accent" : "bg-secondary",
            ].join(" ")}
          >
            <span>{r.emoji}</span>
            <NumberTicker value={r.count} className="text-xs text-muted-foreground" />
          </button>
        )
        // Until the row is activated, render the bare chip (still fully
        // clickable) without its Base UI Tooltip root — the name tooltip
        // only matters on hover, and hover activates the row.
        if (!names || !activated) return <div key={i}>{chip}</div>
        return (
          <Tooltip key={i}>
            <TooltipTrigger render={chip} />
            <TooltipContent>Reacted by {names}</TooltipContent>
          </Tooltip>
        )
      })}
      {activated ? (
        <Tooltip>
          <EmojiPickerPopover side="top" align="start" onPick={(e) => onReact?.(e)}>
            <TooltipTrigger render={<button className={`grid h-6 w-7 place-items-center ${radiusClass} bg-secondary text-muted-foreground hover:text-foreground`} aria-label="Add reaction" />}>
              <SmilePlus className="size-4" />
            </TooltipTrigger>
          </EmojiPickerPopover>
          <TooltipContent>Add reaction</TooltipContent>
        </Tooltip>
      ) : (
        <button className={`grid h-6 w-7 place-items-center ${radiusClass} bg-secondary text-muted-foreground hover:text-foreground`} aria-label="Add reaction">
          <SmilePlus className="size-4" />
        </button>
      )}
    </div>
  )
}
