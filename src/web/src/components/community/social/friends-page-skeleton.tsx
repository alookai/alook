import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { HOME_TAB_COLUMN_CLASS } from "../home-tab-layout"

export function FriendsPageSkeleton({
  reserveBackSlot = false,
}: {
  reserveBackSlot?: boolean
}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading friends"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
    >
      <div className="shrink-0 px-4">
        <header data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex h-12 items-center gap-2 border-b border-border/40`}>
          {reserveBackSlot && (
            <Skeleton data-slot="loading-back-placeholder" aria-hidden className="size-7 shrink-0 rounded-md sm:hidden" />
          )}
          <div aria-hidden className="inline-flex h-8 items-center gap-1 p-0.75 text-muted-foreground">
            <span className="inline-flex h-[calc(100%-1px)] items-center px-2 py-1 text-sm font-medium">All</span>
            <span className="inline-flex h-[calc(100%-1px)] items-center px-2 py-1 text-sm font-medium">New</span>
          </div>
        </header>
      </div>
      <ScrollArea className="min-h-0 flex-1" contentClassName="flex min-h-full flex-col p-4">
        <div data-slot="home-tab-column" className={`${HOME_TAB_COLUMN_CLASS} flex flex-1 flex-col`}>
          <Skeleton className="mb-4 h-11 w-full rounded-md" />
          <div className="flex min-h-0 flex-col">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">All friends — …</div>
            <FriendRowsSkeleton />
          </div>
          <div className="mt-8 flex min-h-0 flex-col">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">Blocked — …</div>
            <FriendRowsSkeleton withActions />
          </div>
        </div>
      </ScrollArea>
      <span className="sr-only">Loading friends</span>
    </div>
  )
}

export function FriendRowsSkeleton({ withActions = false }: { withActions?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5 rounded" />
            <Skeleton className="h-3 w-3/5 rounded" />
          </div>
          {withActions ? (
            <div className="flex gap-2">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <Skeleton className="size-8 shrink-0 rounded-full" />
            </div>
          ) : (
            <Skeleton className="size-8 shrink-0 rounded-full" />
          )}
        </div>
      ))}
    </div>
  )
}
