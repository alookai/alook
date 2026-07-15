import { describe, it, expect } from "vitest"
import { resolveCardStatus } from "./profile-card"

describe("resolveCardStatus — WS overlay wins over row seed", () => {
  it("uses the overlay entry when one exists", () => {
    const out = resolveCardStatus({ emoji: "🎧", text: "Vibing" }, "📚", "Reading")
    expect(out).toEqual({ emoji: "🎧", text: "Vibing" })
  })

  it("falls back to the seed when the overlay has no entry", () => {
    const out = resolveCardStatus(undefined, "📚", "Reading")
    expect(out).toEqual({ emoji: "📚", text: "Reading" })
  })

  it("returns nulls when neither overlay nor seed provide a status", () => {
    expect(resolveCardStatus(undefined, undefined, undefined)).toEqual({ emoji: null, text: null })
    expect(resolveCardStatus(undefined, null, null)).toEqual({ emoji: null, text: null })
  })

  it("lets the overlay clear a seed (emoji: null overrides seed emoji)", () => {
    // When someone clears their status, the WS store's setUserStatus writes
    // { emoji: null, text: null }. That must win over any lingering row seed.
    const out = resolveCardStatus({ emoji: null, text: null }, "📚", "Reading")
    expect(out).toEqual({ emoji: null, text: null })
  })

  it("resolves emoji and text independently", () => {
    // Overlay carries a text-only status (no emoji). Seed offers an emoji.
    // The overlay's presence — not its individual field values — is what
    // decides the source, so the seed's emoji does NOT leak in.
    const out = resolveCardStatus({ emoji: null, text: "AFK" }, "🎧", "Vibing")
    expect(out).toEqual({ emoji: null, text: "AFK" })
  })
})
