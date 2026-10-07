"use client"

import { useId } from "react"
import { Bot, ChevronRight } from "lucide-react"
import { Avatar } from "../avatar"
import {
  useRunningOwnedBots,
  type RunningOwnedBot,
} from "@/hooks/community/use-running-owned-bots"
import { tid } from "@/lib/community/testids"

function BotRow({ bot, onOpenBotAudit }: {
  bot: RunningOwnedBot
  onOpenBotAudit?: (botId: string) => void
}) {
  const content = (
    <>
      <Avatar
        label={bot.name}
        seed={bot.id}
        src={bot.image}
        size={32}
        ringColor="var(--popover)"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {bot.name}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0" aria-hidden>{bot.activityEmoji}</span>
          <span className="truncate">{bot.activityText}</span>
        </span>
      </span>
      {onOpenBotAudit && (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </>
  )

  if (!onOpenBotAudit) {
    return (
      <div
        data-testid={tid.profileRunningBotRow(bot.id)}
        className="flex min-h-11 items-center gap-3 px-1 py-2"
      >
        {content}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-testid={tid.profileRunningBotRow(bot.id)}
      onClick={() => onOpenBotAudit(bot.id)}
      aria-label={`Open ${bot.name} activity`}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors duration-150 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {content}
    </button>
  )
}

export function ProfileRunningBotsCard({ onOpenBotAudit, showShadow = true }: {
  onOpenBotAudit?: (botId: string) => void
  showShadow?: boolean
}) {
  const titleId = useId()
  const { runningBots } = useRunningOwnedBots()

  if (runningBots.length === 0) return null

  return (
    <section
      data-testid={tid.profileRunningBotsCard}
      aria-labelledby={titleId}
      className={[
        "relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-foreground/10 px-4 py-2 bg-popover text-popover-foreground",
        showShadow ? "shadow-2xl shadow-black/20" : "shadow-none",
      ].join(" ")}
    >
      <div className="relative z-10 flex h-6 shrink-0 items-center gap-2">
        <Bot className="size-4 shrink-0 text-foreground" aria-hidden />
        <h2 id={titleId} className="text-sm font-semibold tracking-[-0.015em] text-foreground">
          Running bots
        </h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" aria-label={`${runningBots.length} running ${runningBots.length === 1 ? "bot" : "bots"}`}>
          {runningBots.length}
        </span>
      </div>

      <div className="relative z-10 mt-2 flex min-h-0 flex-1 flex-col border-t border-foreground/10 pt-2">
        <div className="min-h-0 max-h-64 flex-1 divide-y divide-border/40 overflow-y-auto overscroll-contain pr-1 thin-scrollbar">
          {runningBots.map((bot) => (
            <BotRow key={bot.id} bot={bot} onOpenBotAudit={onOpenBotAudit} />
          ))}
        </div>
      </div>
    </section>
  )
}
