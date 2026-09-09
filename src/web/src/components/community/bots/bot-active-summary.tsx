import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { tid } from "@/lib/community/testids"
import type { BotPlanSummary } from "@/hooks/community/use-bots"

export function BotActiveSummary({ summary }: { summary: BotPlanSummary | null }) {
  const active = summary?.activeCount ?? 0
  const total = summary?.ownedCount ?? 0
  const percent = total > 0 ? Math.min(100, Math.max(0, active / total * 100)) : 0
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            data-testid={tid.myBotsPlanSummary}
            disabled={!summary}
            aria-label={summary ? `Active Bots: ${active} of ${total}, ${summary.plan.displayName} plan` : "Active Bots loading"}
            className="flex min-h-11 w-fit items-center gap-2 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6"
          >
            Active Bots
            <svg aria-hidden="true" className="size-4 -rotate-90" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" className="text-border" />
              <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray={`${percent} 100`} strokeLinecap={percent > 0 ? "round" : "butt"} />
            </svg>
          </button>
        }
      />
      <PopoverContent className="w-auto px-3 py-2 text-xs" side="bottom" align="start">
        <p className="tabular-nums">{active} / {total} active</p>
        <p className="text-muted-foreground">{summary?.plan.displayName}</p>
      </PopoverContent>
    </Popover>
  )
}
