"use client"

import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

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
  loading,
  error,
  sourceCount,
  visibleCount,
  query,
}: {
  resolved: boolean
  loading: boolean
  error: boolean
  sourceCount: number
  visibleCount: number
  query: string
}): PeoplePickerViewState {
  if (!resolved) {
    if (error) return "error"
    if (loading) return "loading"
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
    <header className="min-w-0 border-b border-border/50 py-3 pr-12 pl-4">
      <h2 className="truncate text-sm font-semibold">{title}</h2>
      {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
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
    <div data-slot="people-picker-loading">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 rounded-md px-2 py-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32 rounded" />
            {secondaryLine ? <Skeleton className="h-3 w-24 rounded" /> : null}
          </div>
          <Skeleton className={cn("h-8 shrink-0 rounded-md", actionClassName)} />
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
      <div className="flex flex-col items-center gap-3 px-2 py-6 text-center">
        <p className="text-sm text-muted-foreground">{errorMessage}</p>
        <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      </div>
    )
  }
  return (
    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
      {state === "search-empty" ? "No matches." : emptyMessage}
    </p>
  )
}
