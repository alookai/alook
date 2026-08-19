import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Avatar } from "./avatar"
import { ProfileAvatar } from "@/components/avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"

function normalize(html: string): string {
  return html.replace(/_R_[0-9a-z]+_/g, "_ID_").replace(/#[0-9a-z]+_ID_/g, "#_ID_")
}

function render(props: Parameters<typeof Avatar>[0]): string {
  return renderToStaticMarkup(createElement(Avatar, props))
}

describe("Avatar seed contract", () => {
  it("renders a beam svg from the seed", () => {
    const html = render({ label: "Ada", seed: "usr_1" })
    expect(html).toContain("<svg")
    expect(html).not.toContain('data-slot="avatar-fallback"')
  })

  it("drops to a single-letter fallback when no seed is given, never synthesising a beam", () => {
    const html = render({ label: "Ada" })
    expect(html).toContain('data-slot="avatar-fallback"')
    expect(html).toContain(">A<")
    expect(html).not.toContain("<svg")
  })

  it("treats an empty-string seed the same as no seed (letter fallback)", () => {
    const html = render({ label: "Ada", seed: "" })
    expect(html).toContain('data-slot="avatar-fallback"')
    expect(html).not.toContain("<svg")
  })

  it("honors an explicit avatar:beam seed in the label", () => {
    const html = render({ label: serializeBeamSeed("beam-xyz") })
    expect(html).toContain("<svg")
    expect(html).not.toContain('data-slot="avatar-fallback"')
  })

  it("keeps stored avatar sources out of accessible labels", () => {
    const sources = [
      serializeBeamSeed("private-seed"),
      "https://cdn.example.com/private-avatar.png",
    ]

    for (const source of sources) {
      const element = Avatar({ label: source, seed: "usr_1" })
      const html = render({ label: source, seed: "usr_1" })

      expect(element.type).toBe(ProfileAvatar)
      expect(element.props.alt).toBe("")
      expect(html).toContain('aria-hidden="true"')
      expect(html).not.toContain('role="img"')
      expect(html).not.toContain("aria-label")
    }

    expect(render({ label: sources[0]!, seed: "usr_1" })).not.toContain(sources[0]!)
    expect(render({ label: sources[1]!, seed: "usr_1" })).toContain(`src="${sources[1]}"`)
  })

  it("is stable for the same seed", () => {
    expect(normalize(render({ label: "Ada", seed: "usr_1" }))).toBe(
      normalize(render({ label: "Ada", seed: "usr_1" })),
    )
  })

  it("keeps the same avatar when the display name changes but the seed is stable", () => {
    const before = normalize(render({ label: "Ada", seed: "usr_1" }))
    const afterRename = normalize(render({ label: "Adelaide", seed: "usr_1" }))
    expect(afterRename.replace('aria-label="Adelaide"', 'aria-label="Ada"')).toBe(before)
  })

  it("produces different avatars for different seeds", () => {
    const a = normalize(render({ label: "Ada", seed: "usr_1" }))
    const b = normalize(render({ label: "Ada", seed: "usr_2" }))
    expect(a).not.toBe(b)
  })

  it("preserves the community presence badge and caller ring surface", () => {
    const html = render({
      label: "Ada",
      seed: "usr_1",
      size: 64,
      presence: "online",
      ringColor: "var(--popover)",
    })

    expect(html).toContain('data-presence="online"')
    expect(html).toContain("background:var(--status-online)")
    expect(html).toContain("var(--popover)")
  })
})
