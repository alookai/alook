"use client"

import { ChevronLeft } from "@/components/icons/lucide"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { HOME_TAB_COLUMN_CLASS } from "../home-tab-layout"

export function CalendarMobileHeader({
  onBack,
  onToday,
  reserveBackSlot = false,
}: {
  onBack?: () => void
  onToday?: () => void
  reserveBackSlot?: boolean
}) {
  if (!onBack && !reserveBackSlot) return null
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-4 sm:hidden">
      <div className="flex min-w-0 items-center gap-1.5">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-10 text-muted-foreground hover:text-foreground"
            aria-label="Back"
            onClick={onBack}
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : (
          <Skeleton data-slot="loading-back-placeholder" aria-hidden className="size-8 shrink-0 rounded-md" />
        )}
        <span className="truncate text-base font-semibold text-foreground">Calendar</span>
      </div>
      {onToday ? (
        <button
          type="button"
          onClick={onToday}
          className="inline-flex h-9 items-center justify-center rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Today
        </button>
      ) : null}
    </header>
  )
}

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
      <CalendarMobileHeader onBack={onBack} reserveBackSlot={reserveBackSlot} />
      <ScrollArea
        className="@container flex min-h-0 flex-1 flex-col"
        viewportClassName="min-h-0 flex-1"
        contentClassName="flex min-h-full flex-col p-4 sm:p-6"
      >
        <div data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex flex-1 flex-col gap-5 sm:gap-6`}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5 max-sm:sr-only">
              <Skeleton className="h-7 w-28 rounded" />
              <Skeleton className="h-4 w-56 rounded" />
            </div>
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Skeleton className="hidden h-9 w-16 rounded-xl sm:block" />
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-9 w-44 rounded-xl" />
                <Skeleton className="size-9 rounded-full" />
              </div>
              <div className="flex items-center justify-between gap-2 sm:justify-end">
                <Skeleton className="h-9 w-36 rounded-xl" />
                <Skeleton className="h-9 w-36 rounded-full" />
              </div>
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
                  <Skeleton className="h-14 w-full rounded-lg" />
                  <Skeleton className="h-24 w-full rounded-lg" />
                  <Skeleton className="h-14 w-full rounded-lg" />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 pt-2 sm:hidden">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
