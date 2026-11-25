"use client"

import { ChevronLeft } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export function CalendarPageSkeleton({
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
      aria-label="Loading calendar"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="shrink-0 border-b border-border/55 px-4 py-2.5 sm:px-6 sm:py-3">
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
                <Skeleton data-slot="loading-back-placeholder" aria-hidden className="size-8 shrink-0 rounded-md sm:hidden" />
              ) : null}
              <Skeleton className="h-7 w-40 rounded-lg" />
            </div>
            <Skeleton className="hidden h-3 w-36 rounded sm:block" />
            <Skeleton className="h-8.5 w-28 rounded-full sm:hidden" />
          </div>
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <Skeleton className="hidden h-8.5 w-32 rounded-full sm:block" />
            <Skeleton className="h-8.5 flex-1 rounded-full sm:w-38 sm:flex-none" />
            <Skeleton className="h-8.5 w-36 rounded-full" />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col sm:hidden">
        <div className="border-b border-border/50 px-4 pt-3 pb-3">
          <Skeleton className="h-17 w-full rounded-[18px]" />
          <div className="mt-3 flex items-center justify-between">
            <Skeleton className="h-3.5 w-32 rounded" />
            <Skeleton className="h-3.5 w-14 rounded" />
          </div>
        </div>
        <div className="flex flex-col divide-y divide-border/45">
          <div className="flex flex-col gap-2 px-4 py-4">
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className="h-4 w-52 rounded" />
            <Skeleton className="h-3.5 w-36 rounded" />
          </div>
          <div className="flex flex-col gap-2 px-4 py-4">
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className="h-4 w-44 rounded" />
            <Skeleton className="h-3.5 w-32 rounded" />
          </div>
          <div className="flex flex-col gap-2 px-4 py-4">
            <Skeleton className="h-3.5 w-28 rounded" />
            <Skeleton className="h-4 w-56 rounded" />
            <Skeleton className="h-3.5 w-40 rounded" />
          </div>
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col sm:flex">
        <div className="grid shrink-0 grid-cols-[4rem_repeat(7,minmax(0,1fr))] border-b border-border/65">
          <div className="flex items-end justify-end border-r border-border/45 pr-2.5 pb-2">
            <Skeleton className="h-3 w-9 rounded" />
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col items-center justify-center gap-1.5 border-r border-border/35 py-2.5 last:border-r-0"
            >
              <Skeleton className="h-2.5 w-7 rounded" />
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-1.5 w-5 rounded-full" />
            </div>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[4rem_repeat(7,minmax(0,1fr))] overflow-hidden">
          <div className="flex flex-col gap-11 border-r border-border/45 px-2.5 pt-10">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="ml-auto h-2.5 w-8 rounded" />
            ))}
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-4 border-r border-border/35 p-2 pt-6 last:border-r-0">
              <Skeleton className="h-14 w-full rounded-lg" />
              <Skeleton className="mt-6 h-24 w-full rounded-lg" />
              <Skeleton className="mt-4 h-12 w-full rounded-lg" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
