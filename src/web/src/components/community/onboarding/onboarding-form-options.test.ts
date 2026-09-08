import { describe, expect, it } from "vitest"

import {
  ONBOARDING_HARNESSES,
  ONBOARDING_IDENTITIES,
} from "./onboarding-form-options"

describe("onboarding form options", () => {
  it("offers exactly the six supported harnesses with their provider logos", () => {
    expect(ONBOARDING_HARNESSES.map(({ value, label, provider }) => ({
      value,
      label,
      provider,
    }))).toEqual([
      { value: "claude", label: "Claude Code", provider: "claude" },
      { value: "codex", label: "Codex", provider: "codex" },
      { value: "grok", label: "Grok Build", provider: "grok" },
      { value: "cursor", label: "Cursor", provider: "cursor" },
      { value: "opencode", label: "OpenCode", provider: "opencode" },
      { value: "pi", label: "Pi", provider: "pi" },
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
