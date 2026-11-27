"use client"

import { useState } from "react"
import { Bot, ChevronDown, ExternalLink } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { tid } from "@/lib/community/testids"
import { ScheduleActorAvatar } from "./schedule-actor"
import type { ScheduleActor } from "./schedule-types"

const NOTICE_ACTION_CLASS =
  "h-8 shrink-0 gap-1.5 rounded-full border border-border/75 bg-background/90 px-3 text-xs font-medium text-foreground shadow-none hover:bg-muted dark:border-white/12 dark:bg-white/6 dark:hover:bg-white/10 sm:h-7"

export function ScheduleBotNotice({
  bots,
  selectedBot,
  onAskBot,
  askingBot = false,
  onOpenBots,
}: {
  bots: readonly ScheduleActor[]
  selectedBot: ScheduleActor | null
  onAskBot?: (botId: string) => void
  askingBot?: boolean
  onOpenBots?: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const directBot = selectedBot ?? (bots.length === 1 ? bots[0] ?? null : null)

  return (
    <div
      role="note"
      aria-label="How schedules are managed"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/50 bg-muted/35 px-4 py-2 dark:bg-white/3 sm:px-6"
    >
      <p className="flex min-w-0 items-start gap-2 text-xs leading-relaxed text-muted-foreground sm:items-center">
        <Bot className="mt-0.5 size-3.5 shrink-0 text-muted-foreground sm:mt-0" aria-hidden />
        <span>
          {bots.length > 0
            ? "Schedules are set by your bots — ask a bot to add or update its tasks."
            : "Schedules are set by your bots. Create a bot first to schedule tasks."}
        </span>
      </p>

      {bots.length === 0 ? (
        onOpenBots ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={tid.scheduleAskBot}
            onClick={onOpenBots}
            className={NOTICE_ACTION_CLASS}
          >
            <span>Open My Bots</span>
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        ) : null
      ) : directBot && onAskBot ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={tid.scheduleAskBot}
          disabled={askingBot}
          aria-busy={askingBot}
          onClick={() => onAskBot(directBot.id)}
          className={NOTICE_ACTION_CLASS}
        >
          <ScheduleActorAvatar actor={directBot} size={16} />
          <span>{askingBot ? "Starting chat…" : `Ask ${directBot.name} to schedule`}</span>
          <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      ) : onAskBot ? (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid={tid.scheduleAskBot}
                disabled={askingBot}
                aria-busy={askingBot}
                className={NOTICE_ACTION_CLASS}
              />
            }
          >
            <span>{askingBot ? "Starting chat…" : "Ask a bot to schedule"}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1.5">
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              Choose a bot to message
            </div>
            <div className="flex flex-col gap-0.5">
              {bots.map((bot) => (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => {
                    setPickerOpen(false)
                    onAskBot(bot.id)
                  }}
                  className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
                >
                  <ScheduleActorAvatar actor={bot} size={20} />
                  <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
