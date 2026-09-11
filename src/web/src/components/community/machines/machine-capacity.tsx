"use client"

import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { MachineCapacity } from "@/hooks/community/use-machines"

export function MachineCapacityUsage({ summary, onViewPlan }: { summary: MachineCapacity | null; onViewPlan: () => void }) {
  const online = summary?.onlineCount ?? 0
  const limit = summary?.limit ?? 0
  const percent = limit > 0 ? Math.min(100, online / limit * 100) : 0
  const name = summary?.isFounder ? "Founder" : summary?.plan.displayName
  return <Popover>
    <PopoverTrigger openOnHover delay={150} render={<button type="button" data-testid="machine-plan-summary" disabled={!summary}
      aria-label={summary ? `Online machines: ${online} of ${limit} allowed, ${summary.ownedCount} owned, ${name} plan` : "Machine usage loading"}
      className="flex min-h-11 w-fit items-center gap-2 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6">
      Online machines
      <svg aria-hidden="true" className="size-4 -rotate-90" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" className="text-border" />
        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray={`${percent} 100`} strokeLinecap={percent > 0 ? "round" : "butt"} />
      </svg>
    </button>} />
    <PopoverContent className="w-64 overflow-hidden p-0" side="bottom" align="start">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-baseline justify-between gap-3"><span className="text-sm font-medium">Online machines</span><span className="font-brand text-xl font-bold leading-none">{name}</span></div>
        <p className="text-2xl font-semibold leading-none tracking-tight tabular-nums" aria-label={`${online} of ${limit} online machine slots used`}>{online}<span className="text-lg font-normal text-muted-foreground"> / {limit}</span></p>
        <p className="text-sm text-muted-foreground">{summary?.ownedCount ?? 0} {summary?.ownedCount === 1 ? "machine" : "machines"} owned</p>
        <PopoverClose onClick={onViewPlan} render={<Button variant="ghost" size="sm" className="-mx-2 min-h-11 justify-between sm:min-h-8" />}>View plan<ArrowRight className="size-3.5" /></PopoverClose>
      </div>
    </PopoverContent>
  </Popover>
}

export function MachineLimitDialog({ open, onOpenChange, onViewPlan, limit, reconnect = false }: { open: boolean; onOpenChange: (open: boolean) => void; onViewPlan: () => void; limit: number; reconnect?: boolean }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md" data-testid="machine-limit-modal">
      <DialogHeader><DialogTitle>Machine limit reached</DialogTitle><DialogDescription>{reconnect ? `Your plan allows ${limit} online ${limit === 1 ? "machine" : "machines"}. All online slots are in use. Disconnect another machine or change your plan before reconnecting this one.` : `Your plan allows ${limit} ${limit === 1 ? "machine" : "machines"}. Offline machines also count. Remove a machine or change your plan before connecting another.`}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Got it</Button><Button onClick={() => { onOpenChange(false); onViewPlan() }}>View plan</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
