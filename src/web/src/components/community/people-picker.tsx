"use client"

import type { ReactNode } from "react"
import { AlertCircle, Search, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { EmptyState } from "./empty-state"

export type PeoplePickerAsyncState = {
  resolved: boolean
  loading: boolean
  error: boolean
  retrying: boolean
  retry: () => void
}

export type PeoplePickerViewState =
  | "loading"
  | "error"
  | "empty"
  | "search-empty"
  | "ready"

export function resolvePeoplePickerViewState({
  resolved,
  error,
  sourceCount,
  visibleCount,
  query,
}: {
  resolved: boolean
  error: boolean
  sourceCount: number
  visibleCount: number
  query: string
}): PeoplePickerViewState {
  if (!resolved) {
    if (error) return "error"
    return "loading"
  }
  if (sourceCount === 0) return "empty"
  if (query.trim() && visibleCount === 0) return "search-empty"
  return "ready"
}

export function PeoplePickerHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}) {
  return (
    <header className="min-w-0 pt-5 pr-15 pb-1 pl-5 sm:pr-12">
      <h2
        data-slot="dialog-title"
        className="truncate font-heading text-[22px] leading-[1.2] font-bold tracking-[-0.02em]"
      >
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-1.5 text-[13.5px] leading-snug text-muted-foreground">{subtitle}</p>
      ) : null}
    </header>
  )
}

export function PeoplePickerRowsSkeleton({
  secondaryLine = false,
  actionClassName,
}: {
  secondaryLine?: boolean
  actionClassName: string
}) {
  return (
    <div data-slot="people-picker-loading" className="flex flex-col gap-0.5">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3.5 rounded-xl px-3 py-2.5">
          <Skeleton className="size-9.5 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32 rounded" />
            {secondaryLine ? <Skeleton className="h-3 w-24 rounded" /> : null}
          </div>
          <Skeleton className={cn("h-8 shrink-0 rounded-lg", actionClassName)} />
        </div>
      ))}
    </div>
  )
}

export function PeoplePickerBody({
  state,
  loading,
  errorMessage,
  emptyMessage,
  retrying,
  onRetry,
  children,
}: {
  state: PeoplePickerViewState
  loading: ReactNode
  errorMessage: string
  emptyMessage: string
  retrying: boolean
  onRetry: () => void
  children?: ReactNode
}) {
  if (state === "ready") return children
  if (state === "loading") return loading
  if (state === "error") {
    return (
      <div
        data-slot="empty-state"
        className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center"
      >
        <div
          data-slot="empty-state-icon"
          className="grid size-14 place-items-center rounded-full bg-muted text-muted-foreground"
        >
          <AlertCircle className="size-7" />
        </div>
        <p className="max-w-65 text-sm text-muted-foreground">{errorMessage}</p>
        <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    )
  }
  return (
    <EmptyState
      icon={state === "search-empty" ? Search : Users}
      label={state === "search-empty" ? "No matches." : emptyMessage}
    />
  )
}
