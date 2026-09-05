import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

export function ServerLandingPendingFrame() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading server"
      data-community-mobile-transition="suppress"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <UnresolvedMainSkeleton />
    </main>
  )
}
