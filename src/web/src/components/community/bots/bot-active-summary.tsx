import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import type { BotPlanSummary } from "@/hooks/community/use-bots"

export function BotActiveSummary({ summary, isFounder = false, onViewPlan }: { summary: BotPlanSummary | null; isFounder?: boolean; onViewPlan?: () => void }) {
  const active = summary?.activeCount ?? 0
  const total = summary?.ownedCount ?? 0
  const limit = summary?.limit ?? 0
  const percent = limit > 0 ? Math.min(100, Math.max(0, active / limit * 100)) : 0
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
            aria-label={summary ? `Active Bots: ${active} of ${summary.limit} allowed, ${total} owned, ${isFounder ? "Founder" : summary.plan.displayName} plan` : "Active Bots loading"}
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
      <PopoverContent className="w-64 overflow-hidden p-0" side="bottom" align="start">
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">Active bots</span>
            <span className="font-brand text-xl font-bold leading-none">{isFounder ? "Founder" : summary?.plan.displayName}</span>
          </div>
          <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums" aria-label={`${active} of ${limit} active bot slots used`}>
            {active}<span className="text-lg font-normal text-muted-foreground"> / {limit}</span>
          </p>
          <p className="text-sm text-muted-foreground">{total} bots owned</p>
          {onViewPlan && <PopoverClose onClick={onViewPlan} render={<Button variant="ghost" size="sm" className="-mx-2 min-h-11 justify-between sm:min-h-8" />}>View plan<ArrowRight className="size-3.5" /></PopoverClose>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
