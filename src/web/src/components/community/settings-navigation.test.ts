import { describe, expect, it } from "vitest"
import {
  SETTINGS_LOGOUT_CLASS,
  SETTINGS_NAV_CLASS,
  SETTINGS_NAV_LABEL_CLASS,
  SETTINGS_TAB_CLASS,
  SETTINGS_TABS_LIST_CLASS,
} from "./settings-navigation"

describe("settings navigation density", () => {
  it("keeps user and server settings narrow without changing the content inset", () => {
    expect(SETTINGS_NAV_CLASS).toContain("w-44")
    expect(SETTINGS_NAV_CLASS).not.toContain("w-60")
    expect(SETTINGS_NAV_CLASS).toContain("p-3")
    expect(SETTINGS_TABS_LIST_CLASS).toContain("overflow-x-hidden")
    expect(SETTINGS_TAB_CLASS).toContain("h-8")
    expect(SETTINGS_TAB_CLASS).not.toContain("px-0")
    expect(SETTINGS_NAV_LABEL_CLASS).toContain("px-2")
    expect(SETTINGS_LOGOUT_CLASS).not.toContain("px-0")
  })
})
