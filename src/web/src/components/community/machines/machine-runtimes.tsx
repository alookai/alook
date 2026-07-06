"use client"

import type { CommunityMachineRuntime } from "@alook/shared"
import { ProviderLogo } from "@/components/provider-logo"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const chipBase =
  "inline-flex max-w-[160px] items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-[11px]"

export function MachineRuntimes({ runtimes }: { runtimes: CommunityMachineRuntime[] }) {
  if (!runtimes || runtimes.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {runtimes.map((r) => (
        <RuntimeChip key={r.id} runtime={r} />
      ))}
    </div>
  )
}

function RuntimeChip({ runtime }: { runtime: CommunityMachineRuntime }) {
  const chip = (
    <span className={chipBase}>
      <ProviderLogo provider={runtime.id} className="size-3.5 shrink-0" />
      <span className="truncate font-medium text-foreground">{runtime.id}</span>
    </span>
  )
  if (!runtime.version) return chip
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${runtime.id} ${runtime.version}`}
            className={cn(
              chipBase,
              "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            )}
          >
            <ProviderLogo provider={runtime.id} className="size-3.5 shrink-0" />
            <span className="truncate font-medium text-foreground">{runtime.id}</span>
          </button>
        }
      />
      <TooltipContent side="top" sideOffset={4}>
        {runtime.version}
      </TooltipContent>
    </Tooltip>
  )
}
