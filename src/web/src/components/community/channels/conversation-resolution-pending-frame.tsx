import { Skeleton } from "@/components/ui/skeleton"

/** Inert main-area placeholder used until canonical route metadata proves the subtype. */
export function ConversationResolutionPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Resolving conversation"
      data-community-conversation-subtype="unknown"
      className="min-h-0 min-w-0 flex-1 bg-background"
    >
      <Skeleton aria-hidden className="h-full w-full rounded-none" />
      <span className="sr-only">Resolving conversation</span>
    </main>
  )
}
