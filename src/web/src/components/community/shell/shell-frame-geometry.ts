export const COMMUNITY_RAIL_WIDTH = 56
export const COMMUNITY_SURFACE_BORDER_WIDTH = 1
export const COMMUNITY_SEPARATOR_WIDTH = 1
export const COMMUNITY_USER_BAR_DESKTOP_INSET = 8
export const COMMUNITY_COMPOSER_DESKTOP_INSET = 12
export const COMMUNITY_SIDEBAR_DEFAULT_WIDTH = 317
export const COMMUNITY_SIDEBAR_MIN_WIDTH = 100
export const COMMUNITY_SIDEBAR_MAX_WIDTH = 360
export const COMMUNITY_USER_BAR_BASE_HEIGHT = 60
export const COMMUNITY_USER_BAR_HEIGHT_CSS =
  `calc(${COMMUNITY_USER_BAR_BASE_HEIGHT}px + var(--app-safe-area-bottom))`
export const COMMUNITY_LAYOUT_STORAGE_KEY = "react-resizable-panels:community-shell"
export const COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE = "data-community-shell-layout"
export const COMMUNITY_LAYOUT_PREPAINT_SIDEBAR_WIDTH = "--community-shell-prepaint-sidebar-width"
export const COMMUNITY_LAYOUT_PREPAINT_USER_BAR_WIDTH = "--community-shell-prepaint-user-bar-width"

export const communityShellLayoutBootstrapScript = `
try {
  const raw = localStorage.getItem(${JSON.stringify(COMMUNITY_LAYOUT_STORAGE_KEY)});
  if (raw) {
    const parsed = JSON.parse(raw);
    let sidebar = parsed && parsed.sidebar;
    let main = parsed && parsed.main;
    if (!Number.isFinite(sidebar) || !Number.isFinite(main)) {
      const entries = parsed && typeof parsed === "object" ? Object.entries(parsed) : [];
      if (entries.length === 1) {
        const ids = entries[0][0].split(",");
        const layout = entries[0][1] && entries[0][1].layout;
        if (Array.isArray(layout) && layout.length === ids.length) {
          sidebar = layout[ids.indexOf("sidebar")];
          main = layout[ids.indexOf("main")];
        }
      }
    }
    if (
      Number.isFinite(sidebar)
      && Number.isFinite(main)
      && sidebar >= 0
      && sidebar <= 100
      && main >= 0
      && main <= 100
    ) {
      const correction = Number((sidebar * 2 / 100).toFixed(6));
      const root = document.documentElement;
      root.style.setProperty(
        ${JSON.stringify(COMMUNITY_LAYOUT_PREPAINT_SIDEBAR_WIDTH)},
        "clamp(${COMMUNITY_SIDEBAR_MIN_WIDTH}px, calc(" + sidebar + "% - " + correction + "px), ${COMMUNITY_SIDEBAR_MAX_WIDTH}px)",
      );
      root.style.setProperty(
        ${JSON.stringify(COMMUNITY_LAYOUT_PREPAINT_USER_BAR_WIDTH)},
        "calc(var(${COMMUNITY_LAYOUT_PREPAINT_SIDEBAR_WIDTH}) + ${COMMUNITY_RAIL_WIDTH + COMMUNITY_SURFACE_BORDER_WIDTH + COMMUNITY_SEPARATOR_WIDTH}px)",
      );
      root.setAttribute(${JSON.stringify(COMMUNITY_LAYOUT_PREPAINT_ATTRIBUTE)}, "");
    }
  }
} catch {}
`

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

export function desktopUserBarInitialOverlayCssWidth(
  persistedSidebarPercentage?: number,
) {
  return persistedSidebarPercentage === undefined
    ? `${desktopUserBarOverlayWidth(COMMUNITY_SIDEBAR_DEFAULT_WIDTH)}px`
    : desktopUserBarOverlayCssWidth(persistedSidebarPercentage, true)
}

export function desktopSidebarRestoreTarget(
  cachedSidebarWidth?: number,
  persistedSidebarPercentage?: number,
): number | string {
  if (cachedSidebarWidth !== undefined) return cachedSidebarWidth
  if (persistedSidebarPercentage !== undefined) {
    return `${persistedSidebarPercentage}%`
  }
  return COMMUNITY_SIDEBAR_DEFAULT_WIDTH
}
