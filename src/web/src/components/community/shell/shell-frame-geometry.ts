export const COMMUNITY_RAIL_WIDTH = 56
export const COMMUNITY_SEPARATOR_WIDTH = 1
export const COMMUNITY_SHELL_INSET = 12

export function desktopUserBarOverlayWidth(sidebarWidth: number) {
  return sidebarWidth + COMMUNITY_RAIL_WIDTH + COMMUNITY_SEPARATOR_WIDTH
}
