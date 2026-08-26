import { Skeleton } from "@/components/ui/skeleton"

/** Stable, inert viewport shown before authenticated community providers exist. */
export function CommunitySessionPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading community"
      className="flex h-dvh min-h-0 overflow-hidden bg-muted/40 p-2 pl-0"
    >
      <div aria-hidden className="flex w-14 shrink-0 flex-col items-center gap-3 py-2">
        <Skeleton className="size-10 rounded-xl" />
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="size-10 rounded-full" />
      </div>
      <div aria-hidden className="flex min-w-0 flex-1 overflow-hidden rounded-tl-xl border-l border-t border-border/40 bg-background">
        <div className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border/40 bg-sidebar p-3 sm:flex">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-4/5" />
          <Skeleton className="mt-auto h-11 w-full" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 items-center gap-2 border-b border-border/40 px-3">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="flex flex-1 flex-col gap-4 p-4">
            <Skeleton className="h-16 w-2/3 max-w-md" />
            <Skeleton className="h-16 w-3/4 max-w-lg" />
            <Skeleton className="h-16 w-1/2 max-w-sm" />
          </div>
        </div>
      </div>
    </main>
  )
}
