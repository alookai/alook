import { describe, expect, it } from "vitest"

import {
  changeOnboardingCustomValue,
  selectOnboardingOption,
} from "./onboarding-selection-state"

describe("onboarding identity selection state", () => {
  it("keeps preset and custom identities mutually exclusive in both directions", () => {
    let state = changeOnboardingCustomValue("Researcher", "custom")

    expect(state).toEqual({ value: "custom", customValue: "Researcher" })

    state = selectOnboardingOption(state, "office", "custom")
    expect(state).toEqual({ value: "office", customValue: "" })

    state = changeOnboardingCustomValue("Designer", "custom")
    expect(state).toEqual({ value: "custom", customValue: "Designer" })
  })
})
