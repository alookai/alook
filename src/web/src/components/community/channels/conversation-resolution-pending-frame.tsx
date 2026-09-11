import { UnresolvedMainSkeleton } from "../shell/unresolved-main-skeleton"

/** Inert main-area placeholder used until canonical route metadata proves the subtype. */
export function ConversationResolutionPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Resolving conversation"
      data-community-conversation-subtype="unknown"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <UnresolvedMainSkeleton />
      <span className="sr-only">Resolving conversation</span>
    </main>
  )
}
