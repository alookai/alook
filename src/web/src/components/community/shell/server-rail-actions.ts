import { communityServerId } from "@/lib/community/community-route"

export type ServerRailOverlay = "settings" | "invite"

export type ServerRailOverlayAction =
  | { kind: "open-active" }
  | { kind: "navigate"; href: string }

export function resolveServerRailOverlayAction({
  targetServerId,
  activeServerId,
  overlay,
  hasActiveOpener,
  publishedHref,
}: {
  targetServerId: string
  activeServerId?: string
  overlay: ServerRailOverlay
  hasActiveOpener: boolean
  publishedHref?: string
}): ServerRailOverlayAction {
  if (targetServerId === activeServerId && hasActiveOpener) {
    return { kind: "open-active" }
  }
  if (targetServerId === activeServerId && publishedHref
    && communityServerId(publishedHref) === targetServerId) {
    const href = new URL(publishedHref, "https://alook.local")
    href.searchParams.set(overlay, "1")
    return { kind: "navigate", href: `${href.pathname}${href.search}${href.hash}` }
  }
  return {
    kind: "navigate",
    href: `/c/channels/${targetServerId}?${overlay}=1`,
  }
}
