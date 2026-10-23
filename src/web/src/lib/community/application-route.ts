import { resolveCommunityModulePlan } from "./community-route"

export function isCommunityApplicationPath(pathname: string): boolean {
  const route = resolveCommunityModulePlan(pathname).route
  return route !== "unknown" && route !== "public-invite"
}
