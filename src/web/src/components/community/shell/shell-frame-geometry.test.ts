import { describe, expect, it } from "vitest"
import {
  COMMUNITY_RAIL_WIDTH,
  COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE,
  COMMUNITY_SIDEBAR_MAX_WIDTH,
  COMMUNITY_SIDEBAR_MIN_WIDTH,
  COMMUNITY_SEPARATOR_WIDTH,
  COMMUNITY_SHELL_INSET,
  COMMUNITY_SURFACE_BORDER_WIDTH,
  COMMUNITY_USER_BAR_BASE_HEIGHT,
  COMMUNITY_USER_BAR_HEIGHT_CSS,
  desktopUserBarOverlayCssWidth,
  desktopUserBarOverlayWidth,
  mobileInboxAvailableHeight,
} from "./shell-frame-geometry"

describe("desktop community shell geometry", () => {
  it("mirrors the user bar and composer around the sidebar boundary", () => {
    const sidebarWidth = 240
    const mainStart = COMMUNITY_RAIL_WIDTH
      + COMMUNITY_SURFACE_BORDER_WIDTH
      + sidebarWidth
      + COMMUNITY_SEPARATOR_WIDTH
    const overlayLeft = COMMUNITY_RAIL_WIDTH - COMMUNITY_RAIL_WIDTH
    const userBarRight =
      overlayLeft + desktopUserBarOverlayWidth(sidebarWidth) - COMMUNITY_SHELL_INSET
    const composerLeft = mainStart + COMMUNITY_SHELL_INSET

    expect(mainStart - userBarRight).toBe(COMMUNITY_SHELL_INSET)
    expect(composerLeft - mainStart).toBe(COMMUNITY_SHELL_INSET)
  })

  it("seeds the overlay from the same constrained percentage as the sidebar panel", () => {
    expect(desktopUserBarOverlayCssWidth(COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE, true)).toBe(
      `calc(clamp(${COMMUNITY_SIDEBAR_MIN_WIDTH}px, calc(24% - 0.48px), ${COMMUNITY_SIDEBAR_MAX_WIDTH}px) + 58px)`,
    )
    expect(desktopUserBarOverlayCssWidth(COMMUNITY_SIDEBAR_DEFAULT_PERCENTAGE, false)).toBe(
      "calc(calc(24% - 0.24px) + 57px)",
    )
    expect(desktopUserBarOverlayCssWidth(-20, false)).toContain("0%")
    expect(desktopUserBarOverlayCssWidth(120, false)).toContain("100%")
  })
})

describe("mobile Inbox shell geometry", () => {
  it("uses the same 60px visual-plus-margin footprint as the mobile Composer", () => {
    expect(COMMUNITY_USER_BAR_BASE_HEIGHT).toBe(60)
    expect(COMMUNITY_USER_BAR_HEIGHT_CSS).toBe("60px")
  })

  it("defaults both safe areas to zero", () => {
    expect(mobileInboxAvailableHeight(568)).toBe(508)
  })

  it.each([
    [568, 0, 508],
    [844, 0, 784],
    [844, 20, 764],
    [320, 30, 230],
    [80, 30, 0],
  ])(
    "caps a %ipx viewport below its %ipx top safe area",
    (height, top, expected) => {
      expect(mobileInboxAvailableHeight(height, top)).toBe(expected)
    },
  )
})
