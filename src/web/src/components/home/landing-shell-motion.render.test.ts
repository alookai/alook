import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import {
  LandingMobileChatMotion,
  LandingShellMotion,
  landingChannelTreeScopeKey,
} from "./landing-shell-motion"
import { sceneSnapshot, SCENE_MAX_BEAT, type LandingScene } from "./landing-shell-motion-timeline"

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

describe("landing human portraits", () => {
  it.each(["server", "continuity", "spaces"] as const)("uses a photo for the owner in %s", (scene) => {
    const markup = renderToStaticMarkup(createElement(LandingShellMotion, { scene, beat: SCENE_MAX_BEAT[scene] }))
    expect(markup).toContain('data-avatar-kind="photo"')
    expect(markup).toContain('data-avatar-kind="beam"')
  })
})

describe("human teammates replying to Alli", () => {
  it.each([["server", 6, 4], ["continuity", 9, 2], ["continuity", 14, 2]] as const)(
    "renders human reply portraits in %s at beat %s",
    (scene, beat, expectedPhotos) => {
      const markup = renderToStaticMarkup(createElement(LandingShellMotion, { scene, beat }))
      expect(markup.match(/data-avatar-kind="photo"/g)?.length).toBeGreaterThanOrEqual(expectedPhotos)
      expect(markup).toContain('data-avatar-kind="beam"')
    },
  )
})

describe("composer-to-message continuity", () => {
  it.each([["server", 1, 2], ["provider", 6, 7], ["continuity", 1, 2]] as const)(
    "posts the same text typed in %s",
    (scene, typingBeat, postedBeat) => {
      const draft = sceneSnapshot(scene, typingBeat).composerText
      expect(draft.length).toBeGreaterThan(0)
      const typing = renderToStaticMarkup(createElement(LandingShellMotion, { scene, beat: typingBeat }))
      const posted = renderToStaticMarkup(createElement(LandingShellMotion, { scene, beat: postedBeat }))
      expect(typing).toContain(draft)
      expect(posted).toContain(draft)
      expect(sceneSnapshot(scene, postedBeat).composerText).toBe("")
    },
  )
  it("uses the same request on the embedded phone", () => {
    const draft = sceneSnapshot("server", 1).composerText
    expect(renderToStaticMarkup(createElement(LandingMobileChatMotion, { beat: 1 }))).toContain(draft)
    expect(renderToStaticMarkup(createElement(LandingMobileChatMotion, { beat: 2 }))).toContain(draft)
  })
})
