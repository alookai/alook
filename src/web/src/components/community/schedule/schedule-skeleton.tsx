"use client"

import { ChevronLeft } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import styles from "./schedule.module.css"

function ShimmerBar({ className }: { className?: string }) {
  return <div aria-hidden className={cn(styles.skeletonShimmer, "rounded-md", className)} />
}

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
              className="absolute inset-x-1.5 flex flex-col gap-1.5 overflow-hidden rounded-lg border border-border/45 bg-card/85 p-2 backdrop-blur-xs dark:border-white/12 dark:bg-white/6"
            >
              <ShimmerBar className="h-3 w-3/4 rounded" />
              <ShimmerBar className="h-2.5 w-1/2 rounded" />
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
            <ShimmerBar className="size-9 shrink-0 rounded-full" />
            <div className="flex flex-col gap-1.5">
              <ShimmerBar className="h-3.5 w-20 rounded" />
              <ShimmerBar className="h-3 w-16 rounded" />
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-xl border border-border/45 p-3 dark:border-white/10">
              <div className="flex items-center justify-between gap-2">
                <ShimmerBar className="h-3 w-24 rounded" />
                <ShimmerBar className="h-4 w-16 rounded-full" />
              </div>
              <ShimmerBar className="h-4 w-3/5 rounded" />
              <ShimmerBar className="h-3 w-2/5 rounded" />
            </div>
            {group === 0 ? (
              <div className="flex flex-col gap-2 rounded-xl border border-border/45 p-3 dark:border-white/10">
                <ShimmerBar className="h-3 w-28 rounded" />
                <ShimmerBar className="h-4 w-2/5 rounded" />
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
                <ShimmerBar className="size-8 shrink-0 rounded-md sm:hidden" />
              ) : null}
              <ShimmerBar className="h-7 w-40 rounded-lg" />
            </div>
            <ShimmerBar className="hidden h-3 w-36 rounded sm:block" />
            <ShimmerBar className="h-8.5 w-28 rounded-full sm:hidden" />
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <ShimmerBar className="hidden h-8.5 w-32 rounded-full sm:block" />
            <ShimmerBar className="h-8.5 flex-1 rounded-full sm:w-38 sm:flex-none" />
            <ShimmerBar className="h-8.5 w-36 rounded-full" />
          </div>
        </div>
        <div aria-hidden className={styles.loadingRail}>
          <div className={styles.loadingRailBar} />
        </div>
      </header>

      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border/50 bg-muted/35 px-4 py-2.5 dark:bg-white/4 sm:px-6">
        <ShimmerBar className="h-3.5 w-64 max-w-[60%] rounded" />
        <ShimmerBar className="h-6 w-32 rounded-full" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col sm:hidden">
        <div className="border-b border-border/50 px-4 pt-3 pb-3">
          <ShimmerBar className="h-17 w-full rounded-[18px]" />
          <div className="mt-3 flex items-center justify-between">
            <ShimmerBar className="h-3.5 w-32 rounded" />
            <ShimmerBar className="h-3.5 w-14 rounded" />
          </div>
        </div>
        <ScheduleAgendaInlineSkeleton />
      </div>

      <div className="hidden min-h-0 flex-1 flex-col sm:flex">
        <div className="grid shrink-0 grid-cols-[4rem_repeat(7,minmax(0,1fr))] border-b border-border/65">
          <div className="flex items-end justify-end border-r border-border/45 pr-2.5 pb-2">
            <ShimmerBar className="h-3 w-9 rounded" />
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col items-center justify-center gap-1.5 border-r border-border/35 py-2.5 last:border-r-0"
            >
              <ShimmerBar className="h-2.5 w-7 rounded" />
              <ShimmerBar className="size-8 rounded-full" />
              <ShimmerBar className="h-1.5 w-5 rounded-full" />
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[4rem_repeat(7,minmax(0,1fr))] overflow-hidden">
          <div className="flex flex-col gap-11 border-r border-border/45 px-2.5 pt-10">
            {Array.from({ length: 8 }).map((_, i) => (
              <ShimmerBar key={i} className="ml-auto h-2.5 w-8 rounded" />
            ))}
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-4 border-r border-border/35 p-2 pt-6 last:border-r-0">
              <ShimmerBar className="h-14 w-full rounded-lg" />
              <ShimmerBar className="mt-6 h-24 w-full rounded-lg" />
              <ShimmerBar className="mt-4 h-12 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
