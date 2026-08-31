export const COMMUNITY_RAIL_WIDTH = 56
export const COMMUNITY_SEPARATOR_WIDTH = 1
export const COMMUNITY_SHELL_INSET = 12
export const COMMUNITY_USER_BAR_BASE_HEIGHT = 60
export const COMMUNITY_USER_BAR_HEIGHT_CSS =
  `calc(${COMMUNITY_USER_BAR_BASE_HEIGHT}px + var(--app-safe-area-bottom))`

export function mobileInboxAvailableHeight(
  viewportHeight: number,
  safeAreaTop = 0,
  safeAreaBottom = 0,
) {
  return Math.max(
    0,
    viewportHeight
      - COMMUNITY_USER_BAR_BASE_HEIGHT
      - safeAreaTop
      - safeAreaBottom,
  )
}

export function desktopUserBarOverlayWidth(sidebarWidth: number) {
  return sidebarWidth + COMMUNITY_RAIL_WIDTH + COMMUNITY_SEPARATOR_WIDTH
}
