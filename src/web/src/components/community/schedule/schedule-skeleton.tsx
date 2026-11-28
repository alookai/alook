"use client"

import { ChevronLeft } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const WEEK_INLINE_PLACEHOLDERS: ReadonlyArray<{
  colIndex: number
  topPx: number
  heightPx: number
}> = [
  { colIndex: 0, topPx: 548, heightPx: 62 },
  { colIndex: 1, topPx: 608, heightPx: 88 },
  { colIndex: 2, topPx: 572, heightPx: 52 },
  { colIndex: 2, topPx: 790, heightPx: 72 },
  { colIndex: 3, topPx: 660, heightPx: 58 },
  { colIndex: 4, topPx: 590, heightPx: 84 },
  { colIndex: 5, topPx: 720, heightPx: 54 },
]

export function ScheduleWeekInlineSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Updating week tasks"
      data-schedule-inline-skeleton="week"
      className="pointer-events-none absolute inset-0 z-20 grid grid-cols-7"
    >
      {Array.from({ length: 7 }).map((_, colIndex) => (
        <div key={colIndex} className="relative">
          {WEEK_INLINE_PLACEHOLDERS.filter((p) => p.colIndex === colIndex).map((placeholder, idx) => (
            <div
              key={idx}
              style={{ top: placeholder.topPx, height: placeholder.heightPx }}
              className="absolute inset-x-1.5 flex flex-col gap-1.5 overflow-hidden rounded-lg border border-border/45 bg-card/85 p-2 backdrop-blur-xs dark:border-white/12 dark:bg-card/70"
            >
              <Skeleton aria-hidden className="h-3 w-3/4 rounded" />
              <Skeleton aria-hidden className="h-2.5 w-1/2 rounded" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function ScheduleAgendaInlineSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Updating schedule list"
      data-schedule-inline-skeleton="agenda"
      className="flex flex-col divide-y divide-border/50"
    >
      {[0, 1, 2].map((group) => (
        <div
          key={group}
          className="grid gap-3 px-4 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6 sm:px-6 sm:py-5"
        >
          <div className="flex items-center gap-3 sm:items-start sm:pt-1">
            <Skeleton aria-hidden className="size-9 shrink-0 rounded-full" />
            <div className="flex flex-col gap-1.5">
              <Skeleton aria-hidden className="h-3.5 w-20 rounded" />
              <Skeleton aria-hidden className="h-3 w-16 rounded" />
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-xl border border-border/45 p-3 dark:border-white/10">
              <div className="flex items-center justify-between gap-2">
                <Skeleton aria-hidden className="h-3 w-24 rounded" />
                <Skeleton aria-hidden className="h-4 w-16 rounded-full" />
              </div>
              <Skeleton aria-hidden className="h-4 w-3/5 rounded" />
              <Skeleton aria-hidden className="h-3 w-2/5 rounded" />
            </div>
            {group === 0 ? (
              <div className="flex flex-col gap-2 rounded-xl border border-border/45 p-3 dark:border-white/10">
                <Skeleton aria-hidden className="h-3 w-28 rounded" />
                <Skeleton aria-hidden className="h-4 w-2/5 rounded" />
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

export function SchedulePageSkeleton({
  onBack,
  reserveBackSlot = false,
}: {
  onBack?: () => void
  reserveBackSlot?: boolean
} = {}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading schedule"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="relative shrink-0 border-b border-border/55 px-4 py-2.5 sm:px-6 sm:py-3">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:gap-1.5">
            <div className="flex items-center gap-1">
              {onBack ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-2.5 size-11 shrink-0 text-muted-foreground hover:text-foreground sm:hidden"
                  aria-label="Back"
                  onClick={onBack}
                >
                  <ChevronLeft className="size-5" />
                </Button>
              ) : reserveBackSlot ? (
                <span aria-hidden className="-ml-2.5 size-11 shrink-0 sm:hidden" />
              ) : null}
              <Skeleton aria-hidden className="h-6 w-36 rounded-md" />
            </div>
            <Skeleton aria-hidden className="hidden h-3 w-28 rounded sm:block" />
            <Skeleton aria-hidden className="h-8 w-28 rounded-full sm:hidden" />
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <Skeleton aria-hidden className="hidden h-8 w-32 rounded-full sm:block" />
            <Skeleton aria-hidden className="h-8 w-32 rounded-full" />
            <Skeleton aria-hidden className="h-8 w-28 rounded-full" />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:hidden">
        <div className="border-b border-border/50 px-4 py-3">
          <div className="grid grid-cols-7 gap-1.5 rounded-2xl bg-muted/60 p-1.5">
            {Array.from({ length: 7 }).map((_, idx) => (
              <div key={idx} className="flex flex-col items-center gap-1.5 py-1.5">
                <Skeleton aria-hidden className="h-2.5 w-6 rounded" />
                <Skeleton aria-hidden className="h-4 w-5 rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col divide-y divide-border/45">
          {[0, 1, 2].map((idx) => (
            <div key={idx} className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="flex items-center justify-between">
                <Skeleton aria-hidden className="h-3 w-24 rounded" />
                <Skeleton aria-hidden className="h-4 w-16 rounded-full" />
              </div>
              <Skeleton aria-hidden className="h-4 w-3/4 rounded" />
              <Skeleton aria-hidden className="h-3 w-1/2 rounded" />
            </div>
          ))}
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col sm:flex">
        <div className="grid shrink-0 grid-cols-[4rem_minmax(0,1fr)] border-b border-border/65">
          <div className="border-r border-border/45" />
          <div className="grid grid-cols-7">
            {Array.from({ length: 7 }).map((_, idx) => (
              <div key={idx} className="flex flex-col items-center gap-1.5 border-r border-border/35 py-2.5 last:border-r-0">
                <Skeleton aria-hidden className="h-3 w-8 rounded" />
                <Skeleton aria-hidden className="size-8 rounded-full" />
              </div>
            ))}
          </div>
        </div>

        <div className="relative grid min-h-0 flex-1 grid-cols-[4rem_minmax(0,1fr)] overflow-hidden">
          <div className="border-r border-border/45 px-2 pt-3">
            {Array.from({ length: 10 }).map((_, idx) => (
              <div key={idx} className="h-15 text-right">
                <Skeleton aria-hidden className="ml-auto h-2.5 w-8 rounded" />
              </div>
            ))}
          </div>
          <div className="relative grid grid-cols-7">
            {Array.from({ length: 7 }).map((_, colIdx) => (
              <div key={colIdx} className="relative border-r border-border/35 last:border-r-0">
                {Array.from({ length: 10 }).map((_, rowIdx) => (
                  <div key={rowIdx} className="h-15 border-b border-border/40" />
                ))}
                {colIdx % 2 === 0 ? (
                  <div
                    className={cn(
                      "absolute inset-x-1.5 flex flex-col gap-1.5 rounded-lg border border-border/45 bg-card/85 p-2 dark:border-white/10 dark:bg-card/70",
                      colIdx === 2 ? "top-28 h-20" : "top-16 h-14",
                    )}
                  >
                    <Skeleton aria-hidden className="h-3 w-3/4 rounded" />
                    <Skeleton aria-hidden className="h-2.5 w-1/2 rounded" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
