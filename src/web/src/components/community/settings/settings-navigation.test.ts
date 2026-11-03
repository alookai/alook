import { describe, expect, it } from "vitest"
import {
  SETTINGS_LOGOUT_CLASS,
  SETTINGS_NAV_CLASS,
  SETTINGS_NAV_FOOTER_CLASS,
  SETTINGS_NAV_LABEL_CLASS,
  SETTINGS_TAB_CLASS,
  SETTINGS_TABS_LIST_CLASS,
} from "./settings-navigation"

describe("responsive settings navigation", () => {
  it("uses a top tab strip on mobile and the compact left rail on desktop", () => {
    expect(SETTINGS_NAV_CLASS).not.toMatch(/(?:^|\s)sm:w-/u)
    expect(SETTINGS_NAV_CLASS).not.toContain("w-60")
    expect(SETTINGS_NAV_CLASS).not.toContain("border-b")
    expect(SETTINGS_NAV_CLASS).not.toContain("sm:border-r")
    // Desktop rail: side padding, and its first tab starts level with the content panel (4rem header row).
    expect(SETTINGS_NAV_CLASS).toContain("sm:px-4")
    expect(SETTINGS_NAV_CLASS).toContain("sm:pt-15")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("overflow-hidden")
    expect(SETTINGS_TABS_LIST_CLASS).not.toContain("overflow-x-auto")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("justify-start")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("p-0")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("group-data-horizontal/tabs:h-11")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("sm:flex-col")
    // Mobile tabs share the strip evenly at the 44px touch-target height.
    expect(SETTINGS_TAB_CLASS).toContain("h-11")
    expect(SETTINGS_TAB_CLASS).toContain("flex-1")
    expect(SETTINGS_TAB_CLASS).toContain("sm:flex-none")
    expect(SETTINGS_TAB_CLASS).toContain("sm:h-9")
    expect(SETTINGS_TAB_CLASS).toContain("sm:w-full")
    expect(SETTINGS_TAB_CLASS).toContain("px-0")
    // The "User Settings" / server-name label is a screen-reader name only (Gus #2375).
    expect(SETTINGS_NAV_LABEL_CLASS).toBe("sr-only")
    expect(SETTINGS_NAV_FOOTER_CLASS).toContain("sm:border-t")
    expect(SETTINGS_NAV_FOOTER_CLASS).toContain("sm:flex-col")
    expect(SETTINGS_LOGOUT_CLASS).toContain("size-11")
    expect(SETTINGS_LOGOUT_CLASS).toContain("sm:h-9")
    expect(SETTINGS_LOGOUT_CLASS).not.toContain("px-0")
  })
})
