"use client"

import type { CommunityMachineRuntime } from "@alook/shared"
import { CircleAlert } from "lucide-react"
import { ProviderLogo } from "@/components/provider-logo"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const chipBase =
  "inline-flex max-w-[160px] items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-[11px]"

export function MachineRuntimes({ runtimes }: { runtimes: CommunityMachineRuntime[] | undefined }) {
  // Nullish guard — a legacy CommunityMachineSummary cached client-side may
  // still be missing this field. Do not throw; render nothing.
  const list = runtimes ?? []
  if (list.length === 0) return null
  // Available (healthy) chips first, unhealthy ones trail — `toSorted` keeps
  // relative order stable within each group instead of reshuffling ids.
  const sorted = list.toSorted((a, b) =>
    Number(a.status === "unhealthy") - Number(b.status === "unhealthy")
  )
  return (
    <div className="flex flex-wrap items-center gap-2">
      {sorted.map((r) => (
        <RuntimeChip key={r.id} runtime={r} />
      ))}
    </div>
  )
}

function RuntimeChip({ runtime }: { runtime: CommunityMachineRuntime }) {
  const unhealthy = runtime.status === "unhealthy"
  // Tooltip content — version by default; "Unavailable — check daemon logs"
  // when the runtime is flagged unhealthy. Both cases render as a button so
  // keyboard users can focus and read the tooltip.
  const tooltipText = unhealthy
    ? runtime.lastError
      ? `Unavailable (${runtime.lastError}) — check daemon logs`
      : "Unavailable — check daemon logs"
    : runtime.version

  const chipInner = (
    <>
      {unhealthy ? (
        <CircleAlert className="size-3 shrink-0" aria-hidden />
      ) : (
        <ProviderLogo provider={runtime.id} className="size-3.5 shrink-0" />
      )}
      <span className="truncate font-medium text-foreground">{runtime.id}</span>
    </>
  )

  if (!tooltipText) {
    return (
      <span className={cn(chipBase, unhealthy && "opacity-40")}>{chipInner}</span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={unhealthy ? `${runtime.id} unavailable` : `${runtime.id} ${runtime.version}`}
            className={cn(
              chipBase,
              unhealthy && "opacity-40 cursor-not-allowed",
              !unhealthy && "transition-colors hover:bg-accent",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            )}
          >
            {chipInner}
          </button>
        }
      />
      <TooltipContent side="top" sideOffset={4}>
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  )
}
