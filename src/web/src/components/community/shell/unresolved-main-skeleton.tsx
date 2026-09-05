import { Skeleton } from "@/components/ui/skeleton"

export function UnresolvedMainSkeleton() {
  return (
    <Skeleton
      aria-hidden
      data-community-unresolved-main=""
      className="min-h-0 h-full w-full flex-1 rounded-none"
    />
  )
}
