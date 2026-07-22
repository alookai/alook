import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Avatar } from "./avatar"
import { serializeBeamSeed } from "@/lib/avatar/seed-url"

// React's `useId` embeds a per-render counter (`_R_1_`, `_R_2_`, …) into the
// SVG mask/gradient ids, so two independent renders never match byte-for-byte
// even when the derived avatar is identical. Strip those so equality checks
// compare the derived avatar, not the render ordinal.
function normalize(html: string): string {
  return html.replace(/_R_[0-9a-z]+_/g, "_ID_").replace(/\bmarble_[0-9a-z]+\b/g, "id").replace(/#[0-9a-z]+_ID_/g, "#_ID_")
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

  it("is stable for the same seed", () => {
    expect(normalize(render({ label: "Ada", seed: "usr_1" }))).toBe(
      normalize(render({ label: "Ada", seed: "usr_1" })),
    )
  })

  it("keeps the same avatar when the display name changes but the seed is stable", () => {
    const before = normalize(render({ label: "Ada", seed: "usr_1" }))
    const afterRename = normalize(render({ label: "Adelaide", seed: "usr_1" }))
    expect(afterRename).toBe(before)
  })

  it("produces different avatars for different seeds", () => {
    const a = normalize(render({ label: "Ada", seed: "usr_1" }))
    const b = normalize(render({ label: "Ada", seed: "usr_2" }))
    expect(a).not.toBe(b)
  })
})
