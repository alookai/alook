import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "node:fs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, it, expect } from "vitest"
import { resolveCardStatus, resolveProfileBackdropSeed } from "./profile-card"
import { ProfileCard } from "./profile-card"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import type { Profile } from "@/components/community/social/profile-types"

function renderProfile(overrides: Partial<Profile> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(ProfileCard, {
      embedded: true,
      data: {
        name: "Ren",
        userId: "user_1",
        avatar: "R",
        about: "",
        mutual: 0,
        ...overrides,
      },
      x: 0,
      y: 0,
      bp: "desktop",
      onClose: () => undefined,
    }),
  ))
}

describe("ProfileCard contextual metadata", () => {
  it("omits the badge when no context label exists", () => {
    const html = renderProfile()

    expect(html).not.toContain("community-profile-context-badge")
    expect(html).not.toContain(">Member<")
  })

  it("renders an explicit context label", () => {
    const html = renderProfile({ contextLabel: "Admin" })

    expect(html).toContain('data-testid="community-profile-context-badge"')
    expect(html).toContain("Admin")
  })

  it("keeps mutual-server metadata without a context label", () => {
    const html = renderProfile({ mutual: 2 })

    expect(html).not.toContain("community-profile-context-badge")
    expect(html).toContain("2 mutual servers")
  })

  it("shows every bot's clickable owner but withholds preview from nonowners", () => {
    const html = renderProfile({
      identity: {
        kind: "bot",
        ownerProfile: { id: "owner_1", handle: "Owner#0042" },
        ownedByViewer: false,
      },
    })

    expect(html).toContain('data-testid="community-profile-owner-link"')
    expect(html).toContain("@Owner#0042")
    expect(html).not.toContain("community-bot-audit-preview")
  })

  it("mounts the fixed secondary preview only for the owning viewer", () => {
    const html = renderProfile({
      identity: {
        kind: "bot",
        ownerProfile: { id: "owner_1", handle: "Owner#0042" },
        ownedByViewer: true,
      },
    })

    expect(html).toContain('data-testid="community-bot-audit-preview"')
    expect(html).toContain("h-40")
  })

  it("wraps owner metadata and exposes a full accessible label while truncating long handles", () => {
    const handle = `${"VeryLongOwner".repeat(4)}#0042`
    const html = renderProfile({
      identity: {
        kind: "bot",
        ownerProfile: { id: "owner_1", handle },
        ownedByViewer: false,
      },
    })

    expect(html).toContain("flex min-w-0 flex-wrap items-center")
    expect(html).toContain("group/owner flex h-11 min-w-0 max-w-full")
    expect(html).toContain("sm:h-5")
    expect(html).toContain("group-hover/owner:bg-accent")
    expect(html).toContain("group-active/owner:bg-accent/80")
    expect(html).toContain('<span class="min-w-0 truncate">')
    expect(html).toContain(`aria-label="Open owner profile @${handle}"`)
  })

  it("keeps the desktop main card at the anchor and absolutely positions preview above it", () => {
    const source = readFileSync(new URL("./profile-card.tsx", import.meta.url), "utf8")
    const desktop = source.slice(source.indexOf("// desktop:"))
    const mainCard = desktop.indexOf(`data-testid={tid.profileCard}`)
    const independentPreview = desktop.indexOf(
      `className="absolute right-0 bottom-[calc(100%+0.5rem)] w-full"`,
    )

    expect(desktop).toContain(
      `className="relative w-75 overflow-visible border-0 bg-transparent p-0 shadow-none"`,
    )
    expect(mainCard).toBeGreaterThan(0)
    expect(independentPreview).toBeGreaterThan(0)
    expect(independentPreview).toBeLessThan(mainCard)
  })
})

describe("resolveProfileBackdropSeed", () => {
  it("uses the stored generated seed so Shuffle changes face and backdrop together", () => {
    expect(resolveProfileBackdropSeed(serializeBeamSeed("shuffle-seed"), "user-id", "Renamed"))
      .toBe("shuffle-seed")
  })

  it("uses the stable identity fallback when no avatar is stored", () => {
    expect(resolveProfileBackdropSeed(null, "user-id", "Renamed"))
      .toBe("user-id")
  })

  it("keeps photo backdrops stable on identity instead of sampling the image", () => {
    expect(resolveProfileBackdropSeed("https://cdn.example.com/photo.png", "user-id", "Renamed"))
      .toBe("user-id")
  })
})

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
