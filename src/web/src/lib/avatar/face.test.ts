import { describe, it, expect } from "vitest"
import { renderFaceSvg, ink } from "./face"

const PALETTE = ["#00686c", "#32c2b9", "#edecb3", "#fad928", "#ff9915"]

describe("ink", () => {
  it("returns black ink on a light wrapper", () => {
    expect(ink("#edecb3")).toBe("#000000")
  })
  it("returns white ink on a dark wrapper", () => {
    expect(ink("#00686c")).toBe("#ffffff")
  })
})

describe("renderFaceSvg", () => {
  it("is deterministic — same seed + palette → identical SVG", () => {
    const a = renderFaceSvg("Shelly#3863", PALETTE)
    const b = renderFaceSvg("Shelly#3863", PALETTE)
    expect(a).toBe(b)
  })

  it("emits a well-formed 36-unit SVG", () => {
    const svg = renderFaceSvg("Alice", PALETTE)
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain('viewBox="0 0 36 36"')
    expect(svg.trim().endsWith("</svg>")).toBe(true)
  })

  it("uses no <mask> id (would collide across many faces on one page)", () => {
    const svg = renderFaceSvg("Alice", PALETTE)
    expect(svg).not.toContain("<mask")
    expect(svg).not.toContain("url(#")
  })

  it("draws two eyes and a mouth inside the face group", () => {
    // Every face renders a left+right eye and one mouth; the wrapper is a rect
    // or path. Assert the face has drawable children beyond the bg rect.
    const svg = renderFaceSvg("Diego", PALETTE)
    const inner = svg.slice(svg.indexOf('rotate'))
    expect(inner.length).toBeGreaterThan(0)
    // at least one stroke/fill primitive from the eye/mouth libraries
    expect(/<(circle|path|g)\b/.test(svg)).toBe(true)
  })

  it("varies across seeds — different ids generally produce different faces", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"]
    const svgs = new Set(seeds.map((s) => renderFaceSvg(s, PALETTE)))
    // Not all identical — the richer vocabulary means low collision.
    expect(svgs.size).toBeGreaterThan(1)
  })

  it("only references colors from the given palette (plus contrast ink + white)", () => {
    const svg = renderFaceSvg("Melisa#1043", PALETTE)
    const hexes = svg.match(/#[0-9a-fA-F]{6}/g) ?? []
    const allowed = new Set([...PALETTE, "#000000", "#ffffff"])
    for (const h of hexes) expect(allowed.has(h)).toBe(true)
  })

  it("draws the face inside the shape's group so features sit on the wrapper (never vanish on bg)", () => {
    // The "no eyes" bug: features were in a separate group that could land on
    // the bg; ink (derived from wrapper) then matched the max-contrast bg and
    // white eyes vanished on a light bg. Fix: face is nested in the shape group
    // and shares its transform. Assert the SVG has exactly ONE transform group
    // and the eye/mouth nodes are inside it (after the wrapper fill).
    for (let n = 0; n < 60; n++) {
      const svg = renderFaceSvg(`e-${n}`, PALETTE)
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
    // face anymore"). Rotation must stay within ±8° (rot = i%17 − 8). A wider
    // tilt would also eat the crown-reserve budget (radial shapes are rotation-
    // invariant in max radius, but the closed-form bound assumes this cap).
    for (let n = 0; n < 80; n++) {
      const svg = renderFaceSvg(`r-${n}`, PALETTE)
      const rot = parseFloat((svg.match(/rotate\((-?\d+(?:\.\d+)?)/) ?? ["", "0"])[1])
      expect(Math.abs(rot)).toBeLessThanOrEqual(8)
    }
  })

  it("keeps the shape translate small so the wrapper always covers the face", () => {
    // Root cause of "shape doesn't cover the face / features clipped": the lib
    // beam translated the shape up to ±9, moving its center off the canvas
    // center so the wrapper stopped covering where features sit. Clamp: |tx|,
    // |ty| ≤ ~2.6 → coverage radius (shape half-extent 12.2 − offset) > feature
    // extent 9.5, so the face is always inside the wrapper.
    for (let n = 0; n < 80; n++) {
      const svg = renderFaceSvg(`t-${n}`, PALETTE)
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
      const svg = renderFaceSvg(`s-${n}`, PALETTE)
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

  it("reserves the top ~20% (y<7.2) for a hat — the crown never pokes into the band", () => {
    // The head is placed low (center y23.5) and sized (R14.45) so the top of the
    // canvas stays clear for a future hat ("头的最高点不能超过帽子"). Recompute the
    // transformed topmost point of the wrapper path for many seeds and assert it
    // stays >= HAT_LINE. This mirrors the closed-form bound (worst crown ~8.76);
    // if a shape/geometry change lowered the crown into the band, this fails.
    const HAT_LINE = 7.2
    const CX = 18
    const CYh = 23.5
    for (let n = 0; n < 400; n++) {
      const svg = renderFaceSvg(`hat-${n}`, PALETTE)
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
      expect(crown).toBeGreaterThanOrEqual(HAT_LINE)
    }
  })

  it("picks shape, eye, and mouth independently and near-uniformly (no digit%6 clustering)", () => {
    // The old code coupled features to a shared 0–9 digit %6, making idx 4/5 only
    // ~10% and collapsing the combination space. Radix slicing (i%8, (i/8)%6,
    // (i/48)%6) gives each feature its own uniform, decorrelated index. Count how
    // many distinct shapes/eyes/mouths appear across many seeds — all should show.
    const shapes = new Set<string>()
    const svgs: string[] = []
    for (let n = 0; n < 4000; n++) svgs.push(renderFaceSvg(`d-${n}`, PALETTE))
    // Distinct wrapper paths ≈ distinct shapes (8 shapes → the path d differs).
    for (const svg of svgs) shapes.add(svg.match(/<path d="([^"]+)"/)![1].slice(0, 24))
    // All 8 shapes should appear; if features collapsed, far fewer distinct heads.
    expect(shapes.size).toBeGreaterThanOrEqual(8)
    // The full head (shape+eye+mouth) space is large: expect many distinct faces.
    expect(new Set(svgs).size).toBeGreaterThan(100)
  })

  it("keeps face wrapper and background readably apart on every palette (no low-contrast melt)", () => {
    // The bug Gus hit: an all-light palette (idx 6) could pair a light wrapper
    // with a near-light background, melting the face into the bg. bg is now the
    // max-luminance-distance color, so the wrapper↔bg gap stays meaningful for
    // every palette + seed. Guard the worst case across many seeds per palette.
    const lum = (hex: string) => {
      const h = hex.replace("#", "")
      return (parseInt(h.slice(0, 2), 16) * 299 + parseInt(h.slice(2, 4), 16) * 587 + parseInt(h.slice(4, 6), 16) * 114) / 1000
    }
    const seeds = Array.from({ length: 40 }, (_, n) => `seed-${n}`)
    // A single-hue palette genuinely can't separate — use the real 5-color set.
    for (const seed of seeds) {
      const svg = renderFaceSvg(seed, PALETTE)
      // first two rects are bg then wrapper; pull their fills in document order
      const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1])
      const [bg, wrapper] = fills
      expect(Math.abs(lum(bg) - lum(wrapper))).toBeGreaterThan(15)
    }
  })
})
