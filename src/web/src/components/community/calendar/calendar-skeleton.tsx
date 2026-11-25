"use client"

import { ChevronLeft } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { HOME_TAB_COLUMN_CLASS } from "../home-tab-layout"

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
      className="flex min-h-0 flex-1 flex-col"
    >
      <ScrollArea
        className="@container flex min-h-0 flex-1 flex-col"
        viewportClassName="min-h-0 flex-1"
        contentClassName="flex min-h-full flex-col px-4 pt-3 pb-6 sm:p-6"
      >
        <div data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex flex-1 flex-col gap-4 sm:gap-5`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-start sm:gap-2">
              <div className="flex items-center gap-2">
                {onBack ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-ml-2 size-10 text-muted-foreground hover:text-foreground sm:hidden"
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
              <Skeleton className="hidden h-4 w-44 rounded sm:block" />
              <Skeleton className="h-9 w-28 rounded-full sm:hidden" />
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end">
              <Skeleton className="hidden h-9 w-32 rounded-full sm:block" />
              <Skeleton className="h-9 flex-1 rounded-full sm:w-36 sm:flex-none" />
              <Skeleton className="h-9 w-36 rounded-full" />
            </div>
          </div>
          <div className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-4">
            <div className="grid grid-cols-7 gap-2">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <Skeleton className="h-3 w-7 rounded" />
                  <Skeleton className="size-8 rounded-full" />
                </div>
              ))}
            </div>
            <div className="hidden grid-cols-7 gap-2 pt-2 sm:grid">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-2">
                  <Skeleton className="h-14 w-full rounded-md" />
                  <Skeleton className="h-24 w-full rounded-md" />
                  <Skeleton className="h-14 w-full rounded-md" />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:hidden">
              <Skeleton className="h-20 w-full rounded-2xl" />
              <Skeleton className="h-20 w-full rounded-2xl" />
              <Skeleton className="h-20 w-full rounded-2xl" />
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
