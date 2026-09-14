import { CommunityConnectingIndicator } from "./community-connecting-indicator"
import { AppEdgeFade } from "@/components/ui/app-edge-fade"

export function UnresolvedMainSkeleton() {
  return (
    <div
      data-community-unresolved-main=""
      className="relative grid place-items-center min-h-0 h-full w-full flex-1 overflow-hidden bg-(--app-bg)"
    >
      <div className="relative z-20 flex w-full max-w-xs flex-col items-center text-center text-foreground">
        <CommunityConnectingIndicator />
      </div>
      <AppEdgeFade />
    </div>
  )
}
