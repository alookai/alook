import { Skeleton } from "@/components/ui/skeleton"
import { AppEdgeFade } from "@/components/ui/app-edge-fade"

export function UnresolvedMainSkeleton() {
  return (
    <div
      aria-hidden
      data-community-unresolved-main=""
      className="relative min-h-0 h-full w-full flex-1 overflow-hidden bg-(--app-bg)"
    >
      <Skeleton className="absolute inset-0 rounded-none" />
      <AppEdgeFade />
    </div>
  )
}
