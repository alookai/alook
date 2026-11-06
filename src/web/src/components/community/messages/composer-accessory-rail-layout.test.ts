import { describe, expect, it } from "vitest"
import {
  allocateComposerAccessoryRail,
  type ComposerAccessoryRailLayout,
} from "./composer-accessory-rail-layout"

describe("allocateComposerAccessoryRail", () => {
  it.each([
    [false, false, "empty"],
    [true, false, "left-only"],
    [false, true, "centered"],
    [true, true, "centered"],
  ] satisfies Array<[boolean, boolean, ComposerAccessoryRailLayout]>) (
    "maps normal left=%s center=%s to %s",
    (left, center, expected) => {
      expect(allocateComposerAccessoryRail({ mode: "normal", left, center })).toBe(expected)
    },
  )

  it.each([false, true])("uses the remaining left space beside New, typing=%s", left => {
    expect(allocateComposerAccessoryRail({ mode: "normal", left, center: false, right: true })).toBe("edges")
    expect(allocateComposerAccessoryRail({ mode: "normal", left, center: true, right: true })).toBe("centered")
  })
})
