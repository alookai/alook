import { describe, expect, it } from "vitest"

import {
  ONBOARDING_HARNESSES,
  ONBOARDING_IDENTITIES,
} from "./onboarding-form-options"

describe("onboarding form options", () => {
  it("offers exactly the five supported harnesses", () => {
    expect(ONBOARDING_HARNESSES.map(({ value }) => value)).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
      "pi",
    ])
  })

  it("offers exactly the four preset user identities", () => {
    expect(ONBOARDING_IDENTITIES.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "office", label: "Work" },
      { value: "developer", label: "Software development" },
      { value: "founder", label: "Building a company" },
      { value: "home", label: "Home and family" },
    ])
  })
})
