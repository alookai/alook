"use client"

import { useState, type CSSProperties } from "react"
import type { CommunityMachineRuntime } from "@alook/shared"
import { CircleAlert } from "@/components/icons/lucide";
import { ProviderLogo } from "@/components/provider-logo"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { runtimeLabel, visibleRuntimes } from "@/lib/community/runtime-label"

const chipBase =
  "h-auto max-w-40 gap-2 px-2 py-1 text-[11px]"

function UnhealthyRuntimesDisclosure({ runtimes }: { runtimes: CommunityMachineRuntime[] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      {expanded && runtimes.map((r) => <RuntimeChip key={r.id} runtime={r} />)}
      <button
        type="button"
        data-slot="machine-runtimes-unavailable-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-muted-foreground/80 transition-[color,background-color,transform] duration-150 hover:bg-muted/70 hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        {expanded ? "Hide unavailable" : `+${runtimes.length} unavailable`}
      </button>
    </>
  )
}

export function MachineRuntimes({ runtimes }: { runtimes: CommunityMachineRuntime[] | undefined }) {
  // Nullish guard — a legacy CommunityMachineSummary cached client-side may
  // still be missing this field. Do not throw; render nothing.
  const list = visibleRuntimes(runtimes ?? [])
  if (list.length === 0) return null

  const healthy = list.filter((r) => r.status !== "unhealthy")
  const unhealthy = list.filter((r) => r.status === "unhealthy")
  const items =
    healthy.length === 0
      ? unhealthy.map((r) => <RuntimeChip key={r.id} runtime={r} />)
      : [
          ...healthy.map((r) => <RuntimeChip key={r.id} runtime={r} />),
          ...(unhealthy.length > 0
            ? [<UnhealthyRuntimesDisclosure key="__unavailable__" runtimes={unhealthy} />]
            : []),
        ]
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {items}
    </div>
  )
}

function runtimeStickerTilt(name: string): CSSProperties {
  let hash = 2166136261
  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  const angle = (hash & 1 ? -1 : 1) * (0.5 + ((hash >>> 1) % 16) / 10)
  return { "--runtime-badge-tilt": `${angle.toFixed(1)}deg` } as CSSProperties
}

/** The machine-row runtime sticker without status; the landing runtime list shows the same badge (Gus #3214). */
export function RuntimeBadge({ id, label = runtimeLabel(id) }: { id: string; label?: string }) {
  return (
    <Badge style={runtimeStickerTilt(label)} variant="ghost" data-machine-runtime className={chipBase}>
      <ProviderLogo provider={id} className="size-3.5 shrink-0" />
      <span className="truncate font-medium">{label}</span>
    </Badge>
  )
}

function RuntimeChip({ runtime }: { runtime: CommunityMachineRuntime }) {
  const unhealthy = runtime.status === "unhealthy"
  const stickerStyle = runtimeStickerTilt(runtimeLabel(runtime.id))
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
      <span className="truncate font-medium">{runtimeLabel(runtime.id)}</span>
    </>
  )

  if (!tooltipText) {
    return (
      <Badge style={stickerStyle} variant="ghost" data-machine-runtime className={cn(chipBase, unhealthy && "opacity-40")}>{chipInner}</Badge>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        data-slot="badge"
        render={
          <Badge
            variant="ghost"
            style={stickerStyle}
            data-machine-runtime
            render={<button type="button" />}
            aria-label={unhealthy ? `${runtimeLabel(runtime.id)} unavailable` : `${runtimeLabel(runtime.id)} ${runtime.version}`}
            className={cn(
              chipBase,
              unhealthy && "opacity-40 cursor-not-allowed",
              !unhealthy && "transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            )}
          >
            {chipInner}
          </Badge>
        }
      />
      <TooltipContent side="top" sideOffset={4}>
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  )
}
