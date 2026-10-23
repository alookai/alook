import { type ReactNode } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useCommunityRouteFrame } from "@/components/community/shell/community-route-context"
import { CommunityModuleRoute } from "@/components/community/shell/community-module-route"
import { useMeRouteMemory } from "@/hooks/community/use-me-route-memory"

export function CommunityServerModuleHost(_props: { children?: ReactNode }) {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const published = `${pathname}${search ? `?${search}` : ""}`
  const { navigation } = useCommunityRouteFrame()
  const target = navigation?.navigationPending && navigation.pendingHref ? navigation.pendingHref : published
  return <CommunityModuleRoute href={target} routeCommitted={target === published} />
}

export function CommunityMeMemoryHost({ children }: { children?: ReactNode }) {
  useMeRouteMemory(usePathname(), true)
  return children
}
