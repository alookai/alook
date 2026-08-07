export type ServerRailOverlay = "settings" | "invite"

export type ServerRailOverlayAction =
  | { kind: "open-active" }
  | { kind: "navigate"; href: string }

export function resolveServerRailOverlayAction({
  targetServerId,
  activeServerId,
  overlay,
  hasActiveOpener,
}: {
  targetServerId: string
  activeServerId?: string
  overlay: ServerRailOverlay
  hasActiveOpener: boolean
}): ServerRailOverlayAction {
  if (targetServerId === activeServerId && hasActiveOpener) {
    return { kind: "open-active" }
  }
  return {
    kind: "navigate",
    href: `/c/channels/${targetServerId}?${overlay}=1`,
  }
}
