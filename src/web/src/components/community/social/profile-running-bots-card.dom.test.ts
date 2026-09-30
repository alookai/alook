import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import type { BotSummary } from "@/hooks/community/use-bots"
import type { CommunityProfile } from "@/lib/community/models/people"

const mocks = vi.hoisted(() => ({
  bots: [] as BotSummary[],
  data: { bots: [] } as unknown,
  isLoading: false,
  isError: false,
  profiles: new Map<string, CommunityProfile>(),
}))

vi.mock("@/hooks/community/use-bots", () => ({
  useBots: () => ({
    bots: mocks.bots,
    data: mocks.data,
    isLoading: mocks.isLoading,
    isError: mocks.isError,
  }),
}))

vi.mock("@/lib/community-db/projections", () => ({
  useCanonicalProfilesByUserId: () => mocks.profiles,
}))

import {
  ProfileRunningBotsCard,
} from "./profile-running-bots-card"
import { resolveRunningOwnedBots } from "@/hooks/community/use-running-owned-bots"

function bot(id: string, overrides: Partial<BotSummary> = {}): BotSummary {
  return {
    id,
    name: `Bot ${id}`,
    description: "",
    image: null,
    avatarVersion: 0,
    machineId: "machine_1",
    runtime: "codex",
    modelName: null,
    reasoningEffort: null,
    runtimeConfigRevision: 1,
    isActive: true,
    presence: "online",
    lastRefreshContextAt: null,
    dailyActivity: [],
    ...overrides,
  }
}

function renderCard(onOpenBotAudit?: (botId: string) => void) {
  return render(createElement(ProfileRunningBotsCard, { onOpenBotAudit }))
}

afterEach(() => {
  mocks.bots = []
  mocks.data = { bots: [] }
  mocks.isLoading = false
  mocks.isError = false
  mocks.profiles = new Map()
})

describe("resolveRunningOwnedBots", () => {
  it("uses the exact working status instead of online presence", () => {
    const result = resolveRunningOwnedBots([
      bot("working-offline", { presence: "offline" }),
      bot("idle-online"),
      bot("inactive-working", { isActive: false }),
      bot("online-without-status"),
    ], new Map([
      ["working-offline", { id: "working-offline", presence: "offline", statusEmoji: "⚡", statusText: "Working on it" }],
      ["idle-online", { id: "idle-online", presence: "online", statusEmoji: "💤", statusText: "Idle" }],
      ["inactive-working", { id: "inactive-working", presence: "online", statusEmoji: "🛠️", statusText: "Cooking" }],
    ]))

    expect(result.map((item) => item.id)).toEqual(["working-offline"])
  })
})

describe("ProfileRunningBotsCard", () => {
  it("shows live activity copy and opens the selected bot activity", async () => {
    const onOpenBotAudit = vi.fn()
    mocks.bots = [bot("writer", { name: "Writer" })]
    mocks.profiles = new Map([[
      "writer",
      {
        id: "writer",
        presence: "online",
        statusEmoji: "🛠️",
        statusText: "Cooking",
      },
    ]])
    const renderer = renderCard(onOpenBotAudit)

    expect(renderer.getByLabelText("1 running bot")).toBeInTheDocument()
    expect(renderer.getByText("Cooking")).toBeInTheDocument()
    const row = renderer.getByRole("button", { name: "Open Writer activity" })
    await act(async () => row.click())
    expect(onOpenBotAudit).toHaveBeenCalledWith("writer")
  })

  it("reacts to a canonical working-state change without remounting", () => {
    mocks.bots = [bot("runner")]
    mocks.profiles = new Map([["runner", {
      id: "runner",
      presence: "online",
      statusEmoji: "💤",
      statusText: "Idle",
    }]])
    const renderer = renderCard()
    expect(renderer.queryByTestId("community-profile-running-bots-card")).toBeNull()

    mocks.profiles = new Map([["runner", {
      id: "runner",
      presence: "online",
      statusEmoji: "⚡",
      statusText: "Working on it",
    }]])
    renderer.rerender(createElement(ProfileRunningBotsCard))

    expect(renderer.getByTestId("community-profile-running-bot-runner")).toBeInTheDocument()
  })

  it("defaults to nothing for loading, error, empty, and online-idle states", () => {
    mocks.bots = [bot("idle")]
    mocks.profiles = new Map([["idle", {
      id: "idle",
      presence: "online",
      statusEmoji: "💤",
      statusText: "Idle",
    }]])

    expect(renderToStaticMarkup(createElement(ProfileRunningBotsCard))).toBe("")
    mocks.isLoading = true
    mocks.data = undefined
    expect(renderToStaticMarkup(createElement(ProfileRunningBotsCard))).toBe("")
    mocks.isLoading = false
    mocks.isError = true
    expect(renderToStaticMarkup(createElement(ProfileRunningBotsCard))).toBe("")
  })

  it("keeps the liquid-glass and bounded-scroll surface contracts", () => {
    mocks.bots = [bot("one"), bot("two")]
    mocks.profiles = new Map([
      ["one", { id: "one", statusEmoji: "⚡", statusText: "Working on it" }],
      ["two", { id: "two", statusEmoji: "🛠️", statusText: "Cooking" }],
    ])
    const html = renderToStaticMarkup(createElement(ProfileRunningBotsCard))

    expect(html).toContain("bg-popover/70")
    expect(html).toContain("backdrop-blur-2xl")
    expect(html).toContain("backdrop-saturate-150")
    expect(html).toContain("border-foreground/10")
    expect(html).toContain("after:bg-linear-to-br")
    expect(html).toContain("before:via-white/60")
    expect(html).not.toContain("status-online")
    expect(html).not.toContain("Online ·")
    expect(html).not.toContain('presence="online"')
    expect(html).toContain("px-4 py-2")
    expect(html).toContain("flex h-6 items-center gap-2")
    expect(html).not.toContain("flex h-8 items-center")
    expect(html).toContain("max-h-64")
    expect(html).toContain("overflow-y-auto")
    expect(html).toContain("thin-scrollbar")
    expect(html).toContain("block truncate text-sm font-medium")
    expect(html).toContain('<span class="truncate">')
  })

  it("uses a stable translucent surface when nested mobile backdrop composition is unavailable", () => {
    mocks.bots = [bot("runner")]
    mocks.profiles = new Map([["runner", {
      id: "runner",
      statusEmoji: "⚡",
      statusText: "Working on it",
    }]])
    const html = renderToStaticMarkup(createElement(ProfileRunningBotsCard, {
      useBackdropEffect: false,
    }))

    expect(html).toContain("bg-popover/95")
    expect(html).not.toContain("backdrop-blur-2xl")
    expect(html).not.toContain("backdrop-saturate-150")
  })
})
