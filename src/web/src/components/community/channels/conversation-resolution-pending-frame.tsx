import { Skeleton } from "@/components/ui/skeleton"

/** Inert main-area placeholder used until canonical route metadata proves the subtype. */
export function ConversationResolutionPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Resolving conversation"
      data-community-conversation-subtype="unknown"
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background p-4"
    >
      <div aria-hidden className="flex w-full max-w-56 flex-col items-center gap-3">
        <Skeleton className="size-10 rounded-xl" />
        <Skeleton className="h-4 w-40 rounded" />
        <Skeleton className="h-3 w-28 rounded" />
      </div>
      <span className="sr-only">Resolving conversation</span>
    </main>
  )
}
