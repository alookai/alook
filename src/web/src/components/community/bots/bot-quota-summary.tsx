"use client"

import { useState } from "react"
import { ChevronDown } from "lucide-react"
import type { QuotaLimit } from "@alook/shared"
import { ProviderLogo } from "@/components/provider-logo"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { timeAgo } from "@/lib/time"
import { tid } from "@/lib/community/testids"
import type { MachineBackendQuota } from "@/hooks/community/use-machines"

const RESET_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

function productIdentity(limit: QuotaLimit): string {
  return limit.bucket.product.kind === "reported"
    ? `reported:${limit.bucket.product.id}`
    : "unknown"
}

function modelIdentity(limit: QuotaLimit): string {
  const model = limit.bucket.model
  return model.kind === "reported" ? `reported:${model.id}` : model.kind
}

function windowIdentity(limit: QuotaLimit): string {
  const window = limit.bucket.window
  if (window.kind === "rolling") return `rolling:${window.durationSeconds}`
  if (window.kind === "calendar") return `calendar:${window.period}`
  return `provider_defined:${window.id}:${window.durationSeconds === undefined ? "absent" : window.durationSeconds}`
}

export function quotaBucketIdentity(limit: QuotaLimit): string {
  return [
    productIdentity(limit),
    modelIdentity(limit),
    windowIdentity(limit),
    limit.bucket.limitId,
  ].join("\u0000")
}

function decimalPlaces(value: number): number {
  const source = String(value).toLowerCase()
  if (source.includes("e-")) {
    const [coefficient, exponent] = source.split("e-")
    return Number(exponent) + (coefficient.split(".")[1]?.length ?? 0)
  }
  return source.split(".")[1]?.length ?? 0
}

export function remainingPercent(limit: QuotaLimit): number {
  const precision = Math.min(12, decimalPlaces(limit.usedPercent))
  return Number((100 - limit.usedPercent).toFixed(precision))
}

function percentLabel(limit: QuotaLimit): string {
  return `${remainingPercent(limit)}% left`
}

function resetTimestamp(limit: QuotaLimit): number {
  if (!limit.resetsAt) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(limit.resetsAt)
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}

export function selectMostConstrainedLimit(limits: QuotaLimit[]): QuotaLimit | null {
  return limits.toSorted((a, b) => {
    const remaining = remainingPercent(a) - remainingPercent(b)
    if (remaining !== 0) return remaining
    const resetA = resetTimestamp(a)
    const resetB = resetTimestamp(b)
    if (resetA !== resetB) return resetA < resetB ? -1 : 1
    return quotaBucketIdentity(a).localeCompare(quotaBucketIdentity(b))
  })[0] ?? null
}

function productLabel(limit: QuotaLimit): string {
  return limit.bucket.product.displayName
}

function modelLabel(limit: QuotaLimit): string | null {
  const model = limit.bucket.model
  if (model.kind === "not_applicable") return null
  return model.kind === "unknown" ? "Unknown model" : model.id
}

function resetLabel(limit: QuotaLimit): string {
  if (!limit.resetsAt) return "Reset unavailable"
  const parsed = new Date(limit.resetsAt)
  return Number.isNaN(parsed.getTime())
    ? "Reset unavailable"
    : `Resets ${RESET_FMT.format(parsed)}`
}

type QuotaGroup = {
  key: string
  product: string
  model: string | null
  limits: QuotaLimit[]
}

export function groupQuotaLimits(limits: QuotaLimit[]): QuotaGroup[] {
  const groups = new Map<string, QuotaGroup>()
  for (const limit of limits) {
    const key = `${productIdentity(limit)}\u0000${modelIdentity(limit)}`
    const current = groups.get(key)
    if (current) current.limits.push(limit)
    else groups.set(key, {
      key,
      product: productLabel(limit),
      model: modelLabel(limit),
      limits: [limit],
    })
  }
  return [...groups.values()]
}

function hasQuotaLimits(entry: MachineBackendQuota): boolean {
  return (
    entry.capability === "supported"
    && (entry.snapshot.status === "available" || entry.snapshot.status === "stale")
    && entry.snapshot.limits.length > 0
  )
}

function quotaPlaceholder(entries: MachineBackendQuota[] | undefined): string | null {
  if (entries?.some(hasQuotaLimits)) return null
  if (!entries?.length) return "Quota unavailable"
  if (entries.some((entry) => entry.capability === "supported" && entry.snapshot.status === "pending")) {
    return "Quota pending"
  }
  if (entries.every((entry) => entry.capability === "unsupported")) return "Quota not supported"
  return "Quota unavailable"
}

function backendLabel(backendId: string): string {
  return backendId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
}

function backendPlaceholder(entry: MachineBackendQuota): string {
  if (entry.capability === "unsupported") return "Not supported"
  if (entry.capability === "supported" && entry.snapshot.status === "pending") return "Pending"
  return "Unavailable"
}

function constrainedEntry(entries: MachineBackendQuota[]): {
  entry: MachineBackendQuota
  limit: QuotaLimit
} | null {
  const usable = entries.filter(hasQuotaLimits)
  const limit = selectMostConstrainedLimit(usable.flatMap((entry) => (
    entry.snapshot.status === "available" || entry.snapshot.status === "stale"
      ? entry.snapshot.limits
      : []
  )))
  if (!limit) return null
  const entry = usable.find((candidate) => (
    (candidate.snapshot.status === "available" || candidate.snapshot.status === "stale")
    && candidate.snapshot.limits.includes(limit)
  ))
  return entry ? { entry, limit } : null
}

export function MachineQuotaSummary({
  machineId,
  entries,
}: {
  machineId: string
  entries?: MachineBackendQuota[]
}) {
  const [open, setOpen] = useState(false)
  const placeholder = quotaPlaceholder(entries)
  if (placeholder || !entries) {
    return (
      <div
        data-testid={tid.machineQuota(machineId)}
        className="flex h-7 min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      >
        {entries?.map((entry) => (
          <ProviderLogo
            key={entry.scope.agentBackendId}
            provider={entry.scope.agentBackendId}
            className="size-3.5 shrink-0"
          />
        ))}
        <span className="truncate">{placeholder ?? "Quota unavailable"}</span>
      </div>
    )
  }

  const constrained = constrainedEntry(entries)
  if (!constrained) return null
  const limitCount = entries.reduce((count, entry) => (
    entry.snapshot.status === "available" || entry.snapshot.status === "stale"
      ? count + entry.snapshot.limits.length
      : count
  ), 0)
  const stale = constrained.entry.snapshot.status === "stale"
  const summary = [
    "Quota",
    productLabel(constrained.limit),
    percentLabel(constrained.limit),
    ...(limitCount > 1 ? [`${limitCount} limits`] : []),
  ].join(" · ")
  const sortedEntries = entries.toSorted((a, b) => (
    a.scope.agentBackendId.localeCompare(b.scope.agentBackendId)
  ))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-expanded={open}
            aria-label={`Quota details: ${summary}${stale ? ". Stale" : ""}`}
            data-testid={tid.machineQuota(machineId)}
            className="group flex h-11 max-w-full min-w-0 items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-7"
          >
            <ProviderLogo
              provider={constrained.entry.scope.agentBackendId}
              className="size-3.5 shrink-0"
            />
            <span className="truncate text-foreground/85">{summary}</span>
            {stale && <span className="shrink-0 text-warning">Stale</span>}
            <ChevronDown className="size-3 shrink-0 transition-transform group-data-popup-open:rotate-180" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        className="max-h-[min(32rem,calc(100vh-2rem))] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto p-4 thin-scrollbar"
        data-testid={tid.machineQuotaDetail(machineId)}
      >
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-medium text-foreground">Machine quota</h3>
          {sortedEntries.map((entry) => {
            const snapshot = entry.snapshot
            if (snapshot.status !== "available" && snapshot.status !== "stale") {
              return (
                <section key={entry.scope.agentBackendId} className="flex flex-col gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <ProviderLogo provider={entry.scope.agentBackendId} className="size-3.5 shrink-0" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {backendLabel(entry.scope.agentBackendId)}
                    </span>
                  </div>
                  <div className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    {backendPlaceholder(entry)}
                  </div>
                </section>
              )
            }
            const groups = groupQuotaLimits(snapshot.limits)
            return (
              <section key={entry.scope.agentBackendId} className="flex flex-col gap-2">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <ProviderLogo provider={entry.scope.agentBackendId} className="size-3.5 shrink-0" />
                    <span className="truncate text-xs font-medium text-foreground">
                      {backendLabel(entry.scope.agentBackendId)}
                    </span>
                  </div>
                  <span className={snapshot.status === "stale" ? "shrink-0 text-[11px] text-warning" : "shrink-0 text-[11px] text-muted-foreground"}>
                    {[snapshot.planName, snapshot.status === "stale" ? "Stale" : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {groups.length === 0 ? (
                  <div className="rounded-md border border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    Unavailable
                  </div>
                ) : groups.map((group) => (
                  <div key={group.key} className="flex flex-col gap-2">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-xs text-foreground">{group.product}</span>
                      {group.model && (
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {group.model}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col divide-y divide-border/60 rounded-md border border-border/70">
                      {group.limits.map((limit) => (
                        <div key={quotaBucketIdentity(limit)} className="flex flex-col gap-1 p-3">
                          <div className="flex items-start justify-between gap-4">
                            <span className="text-xs text-foreground">
                              {limit.bucket.window.displayName}
                            </span>
                            <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-foreground">
                              {percentLabel(limit)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
                            <span>{resetLabel(limit)}</span>
                            <span className="shrink-0">Updated {timeAgo(snapshot.observedAt)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
