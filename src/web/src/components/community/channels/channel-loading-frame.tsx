import { Skeleton } from "@/components/ui/skeleton"

export function ChannelLoadingFrame() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading conversation"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <Skeleton className="size-4 rounded" />
        <Skeleton className="h-4 w-40 rounded" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col px-3 py-4">
        <div className="flex flex-1 flex-col justify-end gap-4">
          <MessageRowSkeleton width="w-2/3" />
          <MessageRowSkeleton width="w-4/5" />
          <MessageRowSkeleton width="w-1/2" />
        </div>
        <Skeleton className="mt-4 h-12 w-full shrink-0 rounded-xl" />
      </main>
      <span className="sr-only">Loading conversation</span>
    </div>
  )
}

function MessageRowSkeleton({ width }: { width: string }) {
  return (
    <div className="flex items-start gap-3">
      <Skeleton className="size-9 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-28 rounded" />
        <Skeleton className={`h-3.5 rounded ${width}`} />
      </div>
    </div>
  )
}
