import { UnresolvedMainSkeleton } from "../shell/unresolved-main-skeleton"

export function ChannelLoadingFrame() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading conversation"
      data-community-mobile-transition="suppress"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <UnresolvedMainSkeleton />
      <span className="sr-only">Loading conversation</span>
    </div>
  )
}
