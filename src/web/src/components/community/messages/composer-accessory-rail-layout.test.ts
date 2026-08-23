import { describe, expect, it } from "vitest"
import {
  allocateComposerAccessoryRail,
  type ComposerAccessoryRailLayout,
} from "./composer-accessory-rail-layout"

describe("allocateComposerAccessoryRail", () => {
  it.each([
    [false, false, false, "empty"],
    [true, false, false, "left-only"],
    [false, true, false, "centered"],
    [false, false, true, "right-only"],
    [true, true, false, "centered"],
    [true, false, true, "left-right"],
    [false, true, true, "centered"],
    [true, true, true, "centered"],
  ] satisfies Array<[boolean, boolean, boolean, ComposerAccessoryRailLayout]>) (
    "maps normal left=%s center=%s right=%s to %s",
    (left, center, right, expected) => {
      expect(allocateComposerAccessoryRail({ mode: "normal", left, center, right }))
        .toBe(expected)
    },
  )

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("keeps selection centered for left=%s right=%s", (left, right) => {
    expect(allocateComposerAccessoryRail({ mode: "selection", left, right }))
      .toBe("centered")
  })
})
