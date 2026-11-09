import type { CSSProperties, ReactNode } from "react"
import { AppSurface } from "@/components/ui/app-surface"
import { resolveCommunityModulePlan } from "@/lib/community/community-route"
import { tid } from "@/lib/community/testids"
import { Shell } from "./shell"
import { UnresolvedMainSkeleton } from "./unresolved-main-skeleton"

export function CommunityAccountPendingFrame({ pathname, children }: { pathname: string; children?: ReactNode }) {
  return <Shell
    fullViewport={children == null}
    data-testid={tid.initialFrame}
    data-community-startup-frame={children == null ? "" : undefined}
    data-community-route-kind={resolveCommunityModulePlan(pathname).route}
    aria-busy="true"
    aria-label="Loading community"
    style={{
      "--community-pending-background": "transparent",
      ...(children == null ? { "--app-frame": "var(--app-startup-background)" } : {}),
    } as CSSProperties}
  >
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <AppSurface className="rounded-none border-0 bg-transparent">
        {children ?? <UnresolvedMainSkeleton />}
      </AppSurface>
    </div>
  </Shell>
}
