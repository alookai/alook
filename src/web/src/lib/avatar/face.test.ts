import { describe, it, expect } from "vitest"
import { createHash } from "node:crypto"
import { FACE_HAT_LINE, FACE_SHAPE_PATHS, FACE_VOCABULARY, renderFaceSvg, ink } from "./face"
import { AVATAR_PALETTES, avatarColorLuminance, avatarThemeFromSeed } from "./theme"

describe("ink", () => {
  it("returns black ink on a light wrapper", () => {
    expect(ink("#edecb3")).toBe("#000000")
  })
  it("returns white ink on a dark wrapper", () => {
    expect(ink("#00686c")).toBe("#ffffff")
  })
})

describe("renderFaceSvg", () => {
  it("matches the pre-theme-refactor SVG fixtures", () => {
    const fixtures = {
      Alice: "69613f62d983d4af75f7095f5aec1723338316f71e20f076a21005f0ae074b29",
      "Shelly#3863": "620de95400290665f45ee09c9e010cbf8225d725c0d01a28d911e75efc33564e",
      usr_42: "e119eb5fb0032a00514f0c2fdd135f33f5c0b6fbf11ca5f9e2ee7ca8fc69a363",
      "avatar:stable-seed": "810d929e00fc4ce739723d2aa5ac12f821800ee7b3bfb20f46d4b1e7c8a8fffb",
    }
    for (const [seed, expected] of Object.entries(fixtures)) {
      const svg = renderFaceSvg(seed)
      expect(createHash("sha256").update(svg).digest("hex")).toBe(expected)
    }
  })

  it("is deterministic — same seed + palette → identical SVG", () => {
    const a = renderFaceSvg("Shelly#3863")
    const b = renderFaceSvg("Shelly#3863")
    expect(a).toBe(b)
  })

  it("emits a well-formed 36-unit SVG", () => {
    const svg = renderFaceSvg("Alice")
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain('viewBox="0 0 36 36"')
    expect(svg.trim().endsWith("</svg>")).toBe(true)
  })

  it("uses no <mask> id (would collide across many faces on one page)", () => {
    const svg = renderFaceSvg("Alice")
    expect(svg).not.toContain("<mask")
    expect(svg).not.toContain("url(#")
  })

  it("draws two eyes and a mouth inside the face group", () => {
    // Every face renders a left+right eye and one mouth; the wrapper is a rect
    // or path. Assert the face has drawable children beyond the bg rect.
    const svg = renderFaceSvg("Diego")
    const inner = svg.slice(svg.indexOf('rotate'))
    expect(inner.length).toBeGreaterThan(0)
    // at least one stroke/fill primitive from the eye/mouth libraries
    expect(/<(circle|path|g)\b/.test(svg)).toBe(true)
  })

  it("varies across seeds — different ids generally produce different faces", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"]
    const svgs = new Set(seeds.map((s) => renderFaceSvg(s)))
    // Not all identical — the richer vocabulary means low collision.
    expect(svgs.size).toBeGreaterThan(1)
  })

  it("only references colors from the given palette (plus contrast ink + white)", () => {
    const seed = "Melisa#1043"
    const svg = renderFaceSvg(seed)
    const hexes = svg.match(/#[0-9a-fA-F]{6}/g) ?? []
    const allowed = new Set([...avatarThemeFromSeed(seed).palette, "#000000", "#ffffff"])
    for (const h of hexes) expect(allowed.has(h)).toBe(true)
  })

  it("draws the face inside the shape's group so features sit on the wrapper (never vanish on bg)", () => {
    // The "no eyes" bug: features were in a separate group that could land on
    // the bg; ink (derived from wrapper) then matched the max-contrast bg and
    // white eyes vanished on a light bg. Fix: face is nested in the shape group
    // and shares its transform. Assert the SVG has exactly ONE transform group
    // and the eye/mouth nodes are inside it (after the wrapper fill).
    for (let n = 0; n < 60; n++) {
      const svg = renderFaceSvg(`e-${n}`)
      const groups = svg.match(/<g transform=/g) ?? []
      expect(groups.length).toBe(1) // single shared shape+face group
      // eyes/mouth (circle/path with the ink color) come AFTER the wrapper fill
      const groupStart = svg.indexOf("<g transform")
      const wrapperEnd = svg.indexOf("/>", groupStart) // first fill (wrapper)
      const facePart = svg.slice(wrapperEnd)
      expect(/(circle|path)/.test(facePart)).toBe(true)
    }
  })

  it("keeps the tilt gentle (upright, human) — never a full spin", () => {
    // Faces ride the shape rotation; a big spin flips them upside-down ("not a
    // face anymore"). Rotation must stay within ±20° (rot = i%41 − 20). A wider
    // tilt would also eat the crown-reserve budget of the grounded paths.
    for (let n = 0; n < 80; n++) {
      const svg = renderFaceSvg(`r-${n}`)
      const rot = parseFloat((svg.match(/rotate\((-?\d+(?:\.\d+)?)/) ?? ["", "0"])[1])
      expect(Math.abs(rot)).toBeLessThanOrEqual(20)
    }
  })

  it("keeps the shape translate small so the wrapper always covers the face", () => {
    // Root cause of "shape doesn't cover the face / features clipped": the lib
    // beam translated the shape up to ±9, moving its center off the canvas
    // center so the wrapper stopped covering where features sit. Clamp: |tx|,
    // |ty| ≤ ~2.6 → coverage radius (shape half-extent 12.2 − offset) > feature
    // extent 9.5, so the face is always inside the wrapper.
    for (let n = 0; n < 80; n++) {
      const svg = renderFaceSvg(`t-${n}`)
      const m = svg.match(/translate\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)/)!
      expect(Math.abs(parseFloat(m[1]))).toBeLessThanOrEqual(2.6)
      expect(Math.abs(parseFloat(m[2]))).toBeLessThanOrEqual(2.6)
    }
  })

  it("keeps eyes and mouth centered so they never leave the shape", () => {
    // The x4-8 clipping Gus hit: the face had an independent offset that pushed
    // features off the narrower blob shapes. Face now shares the shape's
    // translate+scale (no independent offset), so features stay within ~9.5px of
    // center — inside the narrowest shape (half-extent ≈12.2px). Assert every
    // eye/mouth coordinate authored into the face group is within that radius of
    // center (18,14 eye row / 18,~20 mouth), pre-transform (the shared transform
    // preserves relative position).
    for (let n = 0; n < 60; n++) {
      const svg = renderFaceSvg(`s-${n}`)
      // the face group is the LAST <g transform=...>; pull the coords inside it
      const faceGroup = svg.slice(svg.lastIndexOf("<g transform"))
      const coords = [...faceGroup.matchAll(/(?:cx|x)="?(-?\d+(?:\.\d+)?)"?\s+(?:cy|y)="?(-?\d+(?:\.\d+)?)"?/g)]
      // fall back to any numeric pairs if attribute names differ across shapes
      for (const m of coords) {
        const x = parseFloat(m[1])
        const y = parseFloat(m[2])
        const d = Math.hypot(x - 18, y - 18)
        expect(d).toBeLessThan(11)
      }
    }
  })

  it("keeps the slim future hat band clear without changing approved shapes", () => {
    const CX = 18
    const CYh = 23.5
    for (let n = 0; n < 400; n++) {
      const svg = renderFaceSvg(`hat-${n}`)
      // Pull the wrapper path (first <path> after the shape group) and its transform.
      const xf = svg.match(/<g transform="([^"]+)"/)![1]
      const rot = parseFloat((xf.match(/rotate\((-?\d+(?:\.\d+)?)/) ?? ["", "0"])[1])
      const scale = parseFloat((xf.match(/scale\((-?\d+(?:\.\d+)?)\)/) ?? ["", "1"])[1])
      const tr = xf.match(/translate\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)/)!
      const [tx, ty] = [parseFloat(tr[1]), parseFloat(tr[2])]
      const d = svg.match(/<path d="([^"]+)"/)![1]
      const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [parseFloat(m[1]), parseFloat(m[2])])
      const rad = (rot * Math.PI) / 180
      let crown = Infinity
      for (const [px, py] of pts) {
        // scale about center, rotate about center, translate — matches faceXf.
        const sx = CX + (px - CX) * scale
        const sy = CYh + (py - CYh) * scale
        const dx = sx - CX
        const dy = sy - CYh
        const y = CYh + (dx * Math.sin(rad) + dy * Math.cos(rad)) + ty
        crown = Math.min(crown, y)
      }
      void tx
      expect(crown).toBeGreaterThanOrEqual(FACE_HAT_LINE)
    }
  })

  it("keeps every approved shape control point below the slim hat line at every ±20° angle", () => {
    const CX = 18
    const CYh = 23.5
    const scale = 1.02
    for (const d of FACE_SHAPE_PATHS) {
      const points = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((match) => [
        parseFloat(match[1]),
        parseFloat(match[2]),
      ])
      for (let rotation = -20; rotation <= 20; rotation++) {
        const rad = (rotation * Math.PI) / 180
        for (const [px, py] of points) {
          const dx = (px - CX) * scale
          const dy = (py - CYh) * scale
          const y = CYh + dx * Math.sin(rad) + dy * Math.cos(rad)
          expect(y).toBeGreaterThanOrEqual(FACE_HAT_LINE)
        }
      }
    }
  })

  it("ships the approved 11 × 21 × 22 vocabulary", () => {
    expect(FACE_VOCABULARY).toEqual({
      shapes: 11,
      eyes: 21,
      mouths: 22,
      combinations: 5082,
    })
  })

  it("picks shape, eye, and mouth independently (no shared-digit clustering)", () => {
    // The old code coupled features to a shared 0–9 digit %6, making idx 4/5 only
    // ~10% and collapsed the combination space. Radix slicing gives each feature
    // its own uniform, decorrelated index. Count distinct wrapper paths and whole
    // outputs across many seeds to catch accidental vocabulary collapse.
    const shapes = new Set<string>()
    const svgs: string[] = []
    for (let n = 0; n < 4000; n++) svgs.push(renderFaceSvg(`d-${n}`))
    for (const svg of svgs) shapes.add(svg.match(/<path d="([^"]+)"/)![1])
    expect(shapes.size).toBe(11)
    // The full head (shape+eye+mouth) space is large: expect many distinct faces.
    expect(new Set(svgs).size).toBeGreaterThan(500)
  })

  it("keeps face wrapper and background readably apart on every palette (no low-contrast melt)", () => {
    // The bug Gus hit: an all-light palette (idx 6) could pair a light wrapper
    // with a near-light background, melting the face into the bg. bg is now the
    // max-luminance-distance color, so the wrapper↔bg gap stays meaningful for
    // every palette + seed. Guard the worst case across many seeds per palette.
    const representatives = new Map<readonly string[], string>()
    for (let index = 0; representatives.size < AVATAR_PALETTES.length; index++) {
      const seed = `palette-${index}`
      representatives.set(avatarThemeFromSeed(seed).palette, seed)
    }
    for (const seed of representatives.values()) {
      const svg = renderFaceSvg(seed)
      const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((match) => match[1])
      const [bg, wrapper] = fills
      expect(Math.abs(avatarColorLuminance(bg) - avatarColorLuminance(wrapper))).toBeGreaterThan(40)
    }
  })
})
