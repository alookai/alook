import type { ReactNode } from "react"
import { AccountFixtures } from "./business-fixtures"
import { CommunityRouteFrame } from "@/components/community/shell/community-route-frame"
import { CommunityModuleRouteContext } from "@/contexts/community/module-route"

export function PreviewCommunityShell({ href, children }: { href: string; children?: ReactNode }) {
  return <AccountFixtures key={href}>{children ? <CommunityModuleRouteContext value={{ href, routeCommitted: true }}><div className="flex h-192 min-h-0 flex-col">{children}</div></CommunityModuleRouteContext> : <CommunityRouteFrame sidebar={null}>{null}</CommunityRouteFrame>}</AccountFixtures>
}
