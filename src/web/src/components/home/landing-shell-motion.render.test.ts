import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { LandingMobileChatMotion, LandingShellMotion } from "./landing-shell-motion"
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
