import { describe, expect, it } from "vitest"
import {
  COMMUNITY_RAIL_WIDTH,
  COMMUNITY_SEPARATOR_WIDTH,
  COMMUNITY_SHELL_INSET,
  COMMUNITY_USER_BAR_BASE_HEIGHT,
  COMMUNITY_USER_BAR_HEIGHT_CSS,
  desktopUserBarOverlayWidth,
  mobileInboxAvailableHeight,
} from "./shell-frame-geometry"

describe("desktop community shell geometry", () => {
  it("mirrors the user bar and composer around the sidebar boundary", () => {
    const sidebarWidth = 240
    const mainStart = COMMUNITY_RAIL_WIDTH + sidebarWidth + COMMUNITY_SEPARATOR_WIDTH
    const overlayLeft = COMMUNITY_RAIL_WIDTH - COMMUNITY_RAIL_WIDTH
    const userBarRight =
      overlayLeft + desktopUserBarOverlayWidth(sidebarWidth) - COMMUNITY_SHELL_INSET
    const composerLeft = mainStart + COMMUNITY_SHELL_INSET

    expect(mainStart - userBarRight).toBe(COMMUNITY_SHELL_INSET)
    expect(composerLeft - mainStart).toBe(COMMUNITY_SHELL_INSET)
  })
})

describe("mobile Inbox shell geometry", () => {
  it("uses one safe-area-aware user-bar expression across body portals", () => {
    expect(COMMUNITY_USER_BAR_BASE_HEIGHT).toBe(60)
    expect(COMMUNITY_USER_BAR_HEIGHT_CSS).toBe(
      "calc(60px + var(--app-safe-area-bottom))",
    )
  })

  it("defaults both safe areas to zero", () => {
    expect(mobileInboxAvailableHeight(568)).toBe(508)
  })

  it.each([
    [568, 0, 0, 508],
    [844, 0, 0, 784],
    [844, 20, 34, 730],
    [320, 30, 40, 190],
    [80, 30, 40, 0],
  ])(
    "caps a %ipx viewport with %ipx top and %ipx bottom safe areas",
    (height, top, bottom, expected) => {
      expect(mobileInboxAvailableHeight(height, top, bottom)).toBe(expected)
    },
  )
})
