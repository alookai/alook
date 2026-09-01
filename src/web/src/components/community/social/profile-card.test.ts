import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import TestRenderer, { act, type ReactTestRenderer } from "react-test-renderer"
import { readFileSync } from "node:fs"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, it, expect, vi } from "vitest"
import {
  displayOwnerHandle,
  resolveAuditPreviewPlacement,
  resolveCardStatus,
  resolveProfileBackdropSeed,
} from "./profile-card"
import { ProfileCard } from "./profile-card"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"
import type { Profile } from "@/components/community/social/profile-types"

const mocks = vi.hoisted(() => ({
  profile: undefined as {
    statusEmoji?: string | null
    statusText?: string | null
  } | undefined,
  interruptAgent: vi.fn(),
}))

vi.mock("@/stores/community/ws", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/stores/community/ws")>(),
  useCommunityProfile: () => mocks.profile,
}))

vi.mock("@/hooks/community/use-community-ws", () => ({
  communityWsInterruptAgent: mocks.interruptAgent,
}))

afterEach(() => {
  vi.useRealTimers()
  mocks.interruptAgent.mockReset()
  mocks.profile = undefined
})

function renderProfile(
  overrides: Partial<Profile> = {},
  activityStatus?: { emoji: string; text: string },
) {
  mocks.profile = activityStatus
    ? { statusEmoji: activityStatus.emoji, statusText: activityStatus.text }
    : undefined
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
      activityStatusEmoji: activityStatus?.emoji,
      activityStatusText: activityStatus?.text,
    }),
  ))
}

function interactiveProfile(
  queryClient: QueryClient,
  activityStatus: { emoji: string; text: string },
) {
  mocks.profile = {
    statusEmoji: activityStatus.emoji,
    statusText: activityStatus.text,
  }
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(ProfileCard, {
      embedded: true,
      data: {
        name: "Ren",
        userId: "agent_1",
        avatar: "R",
        about: "",
        mutual: 0,
        identity: {
          kind: "bot",
          ownerProfile: { id: "owner_1", handle: "Owner#0042" },
          ownedByViewer: true,
        },
      },
      x: 0,
      y: 0,
      bp: "desktop",
      onClose: () => undefined,
    }),
  )
}

function findInterruptButton(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType("button").find((button) =>
    button.props["aria-label"] === "Stop current agent turn"
    || button.props["aria-label"] === "Stopping current agent turn")
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

    expect(html).toContain('data-testid="community-profile-bot-badge"')
    expect(html).toContain(">Bot</span>")
    expect(html).toContain('data-testid="community-profile-owner-link"')
    expect(html).toContain(">@Owner</span>")
    expect(html).not.toContain(">@Owner#0042</span>")
    expect(html).toContain('aria-label="Open owner profile @Owner#0042"')
    expect(html).not.toContain("community-bot-audit-preview")
  })

  it("mounts the content-sized secondary preview only for the owning viewer", () => {
    const html = renderProfile({
      identity: {
        kind: "bot",
        ownerProfile: { id: "owner_1", handle: "Owner#0042" },
        ownedByViewer: true,
      },
    })

    expect(html).toContain('data-testid="community-bot-audit-preview"')
    expect(html).not.toContain("h-40")
  })

  it("shows Stop only for the owner while the bot is truly running", () => {
    const identity: Profile["identity"] = {
      kind: "bot",
      ownerProfile: { id: "owner_1", handle: "Owner#0042" },
      ownedByViewer: true,
    }
    const running = renderProfile({ identity }, { emoji: "⚡", text: "Working on it" })
    const starting = renderProfile({ identity }, { emoji: "🌀", text: "Waking up" })
    const nonowner = renderProfile({
      identity: { ...identity, ownedByViewer: false },
    }, { emoji: "⚡", text: "Working on it" })

    expect(running).toContain(">Stop</button>")
    expect(starting).not.toContain(">Stop</button>")
    expect(nonowner).not.toContain(">Stop</button>")
  })

  it("sends once and enters a disabled loading state until exact Idle arrives", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(interactiveProfile(
        queryClient,
        { emoji: "⚡", text: "Working on it" },
      ))
    })

    const stop = findInterruptButton(renderer!)
    expect(stop?.props.disabled).toBe(false)
    await act(async () => {
      stop?.props.onClick()
    })
    await act(async () => findInterruptButton(renderer!)?.props.onClick())

    expect(mocks.interruptAgent).toHaveBeenCalledTimes(1)
    expect(mocks.interruptAgent).toHaveBeenCalledWith("agent_1")
    expect(findInterruptButton(renderer!)?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer!.toJSON())).toContain("Stopping…")

    await act(async () => {
      renderer!.update(interactiveProfile(
        queryClient,
        { emoji: "🌙", text: "Wrapping up" },
      ))
    })
    expect(findInterruptButton(renderer!)?.props.disabled).toBe(true)
    expect(JSON.stringify(renderer!.toJSON())).toContain("Stopping…")

    await act(async () => {
      renderer!.update(interactiveProfile(queryClient, { emoji: "💤", text: "Idle" }))
    })
    expect(findInterruptButton(renderer!)).toBeUndefined()

    await act(async () => {
      renderer!.update(interactiveProfile(
        queryClient,
        { emoji: "⚡", text: "Working on it" },
      ))
    })
    expect(findInterruptButton(renderer!)?.props.disabled).toBe(false)
    await act(async () => renderer!.unmount())
  })

  it("fails open after 10 seconds while the activity is still running", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(interactiveProfile(
        queryClient,
        { emoji: "⚡", text: "Working on it" },
      ))
    })
    await act(async () => findInterruptButton(renderer!)?.props.onClick())
    expect(findInterruptButton(renderer!)?.props.disabled).toBe(true)

    await act(async () => vi.advanceTimersByTime(9_999))
    expect(findInterruptButton(renderer!)?.props.disabled).toBe(true)
    await act(async () => vi.advanceTimersByTime(1))
    expect(findInterruptButton(renderer!)?.props.disabled).toBe(false)
    expect(JSON.stringify(renderer!.toJSON())).toContain("Stop")
    await act(async () => renderer!.unmount())
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
    expect(html).toContain(`>@${displayOwnerHandle(handle)}</span>`)
    expect(html).not.toContain(`>@${handle}</span>`)
    expect(html).toContain(`aria-label="Open owner profile @${handle}"`)
  })

  it("keeps the desktop main card at the anchor and independently docks the preview", () => {
    const source = readFileSync(new URL("./profile-card.tsx", import.meta.url), "utf8")
    const desktop = source.slice(source.indexOf("// desktop:"))
    const mainCard = desktop.indexOf(`data-testid={tid.profileCard}`)
    const independentPreview = desktop.indexOf(`data-testid={tid.botAuditPreviewDock}`)

    expect(desktop).toContain(
      `className="relative w-75 overflow-visible border-0 bg-transparent p-0 shadow-none"`,
    )
    expect(mainCard).toBeGreaterThan(0)
    expect(independentPreview).toBeGreaterThan(0)
    expect(independentPreview).toBeLessThan(mainCard)
    expect(desktop).toContain("ref={popoverRef}")
    expect(source).toContain('addEventListener("animationend", update)')
    expect(source).toContain("cardElement.offsetWidth")
    expect(source).toContain("previewElement.offsetWidth")
    expect(source).toContain("onClick={interruptAgent}")
    expect(source).toContain("communityWsInterruptAgent(data.userId)")
  })
})

describe("resolveAuditPreviewPlacement", () => {
  const card = {
    top: 300,
    right: 700,
    bottom: 600,
    left: 400,
    width: 300,
    height: 300,
  }
  const preview = { width: 300, height: 160 }

  it("prefers the right side whenever it fits", () => {
    expect(resolveAuditPreviewPlacement({
      card,
      preview,
      viewportWidth: 1200,
      viewportHeight: 900,
    })).toBe("right")
  })

  it("falls back left, then above, then below according to available space", () => {
    expect(resolveAuditPreviewPlacement({
      card: { ...card, left: 500, right: 800 },
      preview,
      viewportWidth: 900,
      viewportHeight: 900,
    })).toBe("left")
    expect(resolveAuditPreviewPlacement({
      card: { ...card, left: 20, right: 320 },
      preview,
      viewportWidth: 620,
      viewportHeight: 900,
    })).toBe("top")
    expect(resolveAuditPreviewPlacement({
      card: { ...card, top: 40, bottom: 340, left: 20, right: 320 },
      preview,
      viewportWidth: 620,
      viewportHeight: 900,
    })).toBe("bottom")
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
    const out = resolveCardStatus({ statusEmoji: "🎧", statusText: "Vibing" }, "📚", "Reading")
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
    const out = resolveCardStatus({ statusEmoji: null, statusText: null }, "📚", "Reading")
    expect(out).toEqual({ emoji: null, text: null })
  })

  it("resolves emoji and text independently", () => {
    // Overlay carries a text-only status (no emoji). Seed offers an emoji.
    // The overlay's presence — not its individual field values — is what
    // decides the source, so the seed's emoji does NOT leak in.
    const out = resolveCardStatus({ statusEmoji: null, statusText: "AFK" }, "🎧", "Vibing")
    expect(out).toEqual({ emoji: null, text: "AFK" })
  })
})
