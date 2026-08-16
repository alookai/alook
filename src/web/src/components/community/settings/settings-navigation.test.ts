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
    expect(SETTINGS_NAV_CLASS).toContain("border-b")
    expect(SETTINGS_NAV_CLASS).toContain("sm:w-44")
    expect(SETTINGS_NAV_CLASS).not.toContain("w-60")
    expect(SETTINGS_NAV_CLASS).toContain("sm:border-r")
    expect(SETTINGS_NAV_CLASS).toContain("sm:p-3")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("overflow-x-auto")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("thin-scrollbar")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("group-data-horizontal/tabs:h-11")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("sm:flex-col")
    expect(SETTINGS_TAB_CLASS).toContain("h-11")
    expect(SETTINGS_TAB_CLASS).toContain("sm:h-8")
    expect(SETTINGS_TAB_CLASS).toContain("sm:w-full")
    expect(SETTINGS_TAB_CLASS).not.toContain("px-0")
    expect(SETTINGS_NAV_LABEL_CLASS).toContain("max-w-24")
    expect(SETTINGS_NAV_LABEL_CLASS).toContain("truncate")
    expect(SETTINGS_NAV_LABEL_CLASS).not.toContain("hidden")
    expect(SETTINGS_NAV_FOOTER_CLASS).toContain("border-l")
    expect(SETTINGS_NAV_FOOTER_CLASS).toContain("sm:border-t")
    expect(SETTINGS_LOGOUT_CLASS).toContain("h-11")
    expect(SETTINGS_LOGOUT_CLASS).not.toContain("px-0")
  })
})
