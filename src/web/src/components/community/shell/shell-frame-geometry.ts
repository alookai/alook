export const COMMUNITY_RAIL_WIDTH = 56
export const COMMUNITY_SURFACE_BORDER_WIDTH = 1
export const COMMUNITY_SEPARATOR_WIDTH = 1
export const COMMUNITY_SHELL_INSET = 12
export const COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE = 24
export const COMMUNITY_SIDEBAR_MIN_WIDTH = 160
export const COMMUNITY_SIDEBAR_MAX_WIDTH = 360
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
  return sidebarWidth
    + COMMUNITY_RAIL_WIDTH
    + COMMUNITY_SURFACE_BORDER_WIDTH
    + COMMUNITY_SEPARATOR_WIDTH
}

export function desktopUserBarOverlayCssWidth(
  sidebarPercentage: number,
  constrainToPanelBounds: boolean,
) {
  const percentage = Math.min(100, Math.max(0, sidebarPercentage))
  const panelTrackInset = COMMUNITY_SURFACE_BORDER_WIDTH
    + (constrainToPanelBounds ? COMMUNITY_SEPARATOR_WIDTH : 0)
  const percentageTrackCorrection = Number(
    (percentage * panelTrackInset / 100).toFixed(6),
  )
  const percentageWidth = `calc(${percentage}% - ${percentageTrackCorrection}px)`
  const sidebarWidth = constrainToPanelBounds
    ? `clamp(${COMMUNITY_SIDEBAR_MIN_WIDTH}px, ${percentageWidth}, ${COMMUNITY_SIDEBAR_MAX_WIDTH}px)`
    : percentageWidth
  const fixedWidth = COMMUNITY_RAIL_WIDTH
    + COMMUNITY_SURFACE_BORDER_WIDTH
    + (constrainToPanelBounds ? COMMUNITY_SEPARATOR_WIDTH : 0)
  return `calc(${sidebarWidth} + ${fixedWidth}px)`
}
