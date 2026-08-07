import { describe, expect, it } from "vitest"
import {
  COMMUNITY_RAIL_WIDTH,
  COMMUNITY_SEPARATOR_WIDTH,
  COMMUNITY_SHELL_INSET,
  desktopUserBarOverlayWidth,
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
