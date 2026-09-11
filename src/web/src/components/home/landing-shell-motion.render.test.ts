import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  LandingMobileChatMotion,
  LandingShellMotion,
  landingChannelTreeScopeKey,
} from "./landing-shell-motion"
import { SCENE_MAX_BEAT, type LandingScene } from "./landing-shell-motion-timeline"

vi.mock("./landing-shell-motion.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const ALL_SCENES: LandingScene[] = [
  "server",
  "machine",
  "provider",
  "spaces",
  "identity",
  "continuity",
]

const CHANNEL_SCENES: LandingScene[] = ["server", "spaces", "identity", "continuity"]

function channelHeader(markup: string) {
  const headers = markup.match(/<header role="banner"[\s\S]*?<\/header>/g) ?? []
  return headers.find((header) => header.includes('viewBox="7 0 14 24"'))
}

describe("landing community preview rendering", () => {
  it("uses explicit identities for every Channel Tree fixture dataset", () => {
    expect(landingChannelTreeScopeKey({ scene: "server", room: null, overviewDetails: false }))
      .toBe("landing:root:default")
    expect(landingChannelTreeScopeKey({ scene: "server", room: null, overviewDetails: true }))
      .toBe("landing:root:overview-work")
    expect(landingChannelTreeScopeKey({ scene: "spaces", room: "life", overviewDetails: false }))
      .toBe("landing:space:life")
    expect(landingChannelTreeScopeKey({ scene: "continuity", room: "life", overviewDetails: false }))
      .toBe("landing:continuity:life")
  })

  it.each([
    ["server", 0, false, "landing:root:default", "general"],
    ["server", 0, true, "landing:root:overview-work", "work-general"],
    ["spaces", SCENE_MAX_BEAT.spaces, false, "landing:space:play", "play-lobby"],
    ["continuity", SCENE_MAX_BEAT.continuity, false, "landing:continuity:life", "continuity-family"],
  ] as const)(
    "renders the first %s dataset frame from %s without rows from another scope",
    (scene, beat, overviewDetails, scopeKey, rowId) => {
      const markup = renderToStaticMarkup(createElement(LandingShellMotion, {
        scene,
        beat,
        overviewDetails,
      }))

      expect(markup).toContain(`data-community-channel-tree-scope="${scopeKey}"`)
      expect(markup).toContain(`data-testid="community-channel-row-${rowId}"`)
    },
  )

  it.each(ALL_SCENES)("renders the final %s scene without unresolved fixture identities", (scene) => {
    const markup = renderToStaticMarkup(createElement(LandingShellMotion, {
      scene,
      beat: SCENE_MAX_BEAT[scene],
    }))

    expect(markup).not.toContain("Unknown")
  })

  it.each(CHANNEL_SCENES)("matches the real Text header in the %s scene", (scene) => {
    const markup = renderToStaticMarkup(createElement(LandingShellMotion, {
      scene,
      beat: SCENE_MAX_BEAT[scene],
    }))
    const header = channelHeader(markup)

    expect(header).toBeDefined()
    expect(header).not.toMatch(/aria-label="(?:Gus|Studio|Home|Game Night)"/)
  })

  it("uses the shared mobile Back control and isolated fixture identities", () => {
    const markup = renderToStaticMarkup(createElement(LandingMobileChatMotion, {
      beat: SCENE_MAX_BEAT.server,
    }))
    const header = channelHeader(markup)

    expect(markup).not.toContain("Unknown")
    expect(header).toBeDefined()
    expect(header).toContain('aria-label="Back"')
    expect(header).toMatch(/class="[^"]*size-11[^"]*"/)
    expect(header).not.toContain('aria-label="Gus"')
  })

  it("keeps true mobile header geometry when embedded in a desktop preview", () => {
    const markup = renderToStaticMarkup(createElement(LandingMobileChatMotion, {
      beat: SCENE_MAX_BEAT.server,
    }))
    const header = channelHeader(markup)
    const back = header?.match(/<button[^>]*aria-label="Back"[^>]*>/)?.[0]

    expect(back).toBeDefined()
    expect(back).toContain("size-11")
    expect(back).not.toContain("sm:hidden")
    expect(header).not.toContain("sm:ml-1")
  })
})
