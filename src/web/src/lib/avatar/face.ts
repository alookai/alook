// Generated "beam" face renderer — the richer replacement for boring-avatars'
// fixed beam geometry. Ported from the approved design prototype
// (Alli, avatar-features.mjs). Same 36-unit canvas, same wrapper transform +
// PRNG, same auto-contrast ink as the lib's beam, so it reads as "more of the
// same face", not a new style. Only the feature vocabulary grew:
//   6 shapes (silhouette-distinct, not corner-radius) · 6 eyes · 6 mouths.
// Each seed picks its shape/eye/mouth deterministically, so a given id always
// renders the same face and never flickers across renames.
//
// `beam` only. Marble (server/channel icons, banner) stays on the lib.

const C = 36
const CX = 18
const CY = 18
const R = 17
const TAU = Math.PI * 2
const N = 72

// boring-avatars PRNG helpers (verbatim from the lib bundle, so the wrapper
// transform matches the lib's beam exactly).
function hashSeed(name: string): number {
  let r = 0
  for (let i = 0; i < name.length; i++) {
    r = (r << 5) - r + name.charCodeAt(i)
    r = r & r
  }
  return Math.abs(r)
}
const digit = (n: number, p: number): number => Math.floor((n / Math.pow(10, p)) % 10)
const unit = (n: number, m: number, p?: number): number => {
  const a = n % m
  return p && digit(n, p) % 2 === 0 ? -a : a
}
const pick = (n: number, arr: readonly string[], off = 0): string => arr[(n + off) % arr.length]

// Perceived luminance (0–255), the same weighting the lib uses for faceColor.
function luminance(hex: string): number {
  const h = hex.replace("#", "")
  const r = parseInt(h.substr(0, 2), 16)
  const g = parseInt(h.substr(2, 2), 16)
  const b = parseInt(h.substr(4, 2), 16)
  return (r * 299 + g * 587 + b * 114) / 1000
}

// Contrasting ink color — same luminance rule the lib uses for faceColor.
export function ink(hex: string): string {
  return luminance(hex) >= 128 ? "#000000" : "#ffffff"
}

// Pick the palette color with the greatest luminance distance from `wrapper`,
// for use as the background. The lib's beam uses a fixed offset (bg =
// palette[(i+13)%len]) which can land wrapper + bg on two near-luminance
// colors — a face that melts into its background (the low-contrast bug Gus
// hit on the all-light idx-6 palette). Max-distance guarantees the face reads
// against the bg for every seed/palette. Deterministic: pure function of
// wrapper + palette, so faces stay stable and never flicker.
function farthestByLuminance(wrapper: string, palette: readonly string[]): string {
  const wl = luminance(wrapper)
  let best = palette[0]
  let bestDist = -1
  for (const c of palette) {
    const d = Math.abs(luminance(c) - wl)
    if (d > bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function polyPath(fn: (t: number) => [number, number]): string {
  let d = ""
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * TAU
    const [x, y] = fn(t)
    d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " "
  }
  return d + "Z"
}
// Radial modulation r(t) = R * mod(t) — used for the lopsided/teardrop blobs.
function radial(t: number, mod: (a: number) => number): [number, number] {
  const r = R * mod(t)
  return [CX + r * Math.cos(t), CY + r * Math.sin(t)]
}

// Wrapper shapes: soft, chunky, distinct by SILHOUETTE (proportion + gentle
// asymmetry), not corner-radius — corner differences vanish at 32px under the
// circular crop. No scallop/flower/zigzag (too busy, off the soft-simple
// logic). `round`/`rounded` emit a plain rect (perf); the rest emit a <path>.
type Shape = { rect: number } | { path: string }
const SHAPES: Record<string, Shape> = {
  round: { rect: C },
  rounded: { rect: C / 3 },
  wide: { path: polyPath((t) => [CX + R * 1.02 * Math.cos(t), CY + R * 0.72 * Math.sin(t)]) },
  egg: { path: polyPath((t) => [CX + R * 0.86 * Math.cos(t), CY + R * Math.sin(t) - 2.4 * Math.sin(t) * Math.sin(t)]) },
  potato: { path: polyPath((t) => radial(t, (a) => 0.95 * (1 + 0.11 * Math.sin(a + 0.5) + 0.06 * Math.cos(2 * a - 0.8)))) },
  drop: { path: polyPath((t) => radial(t, (a) => 0.94 * (1 + 0.14 * Math.cos(a - Math.PI / 2)))) },
}
const SHAPE_KEYS = Object.keys(SHAPES)

// Eyes — big, chunky, bold strokes (ESW). Baseline is beam's dot, enlarged.
const ESW = 1.6
type EyeFn = (x: number, y: number, c: string, right?: boolean) => string
const EYES: Record<string, EyeFn> = {
  dot: (x, y, c) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${c}"/>`,
  round: (x, y, c) => `<circle cx="${x}" cy="${y}" r="1.9" fill="${c}"/>`,
  wide: (x, y, c) => `<g><circle cx="${x}" cy="${y}" r="2.1" fill="#fff"/><circle cx="${x}" cy="${y + 0.3}" r="1.15" fill="${c}"/></g>`,
  sleepy: (x, y, c) => `<path d="M${x - 1.8} ${y} q1.8 1.7 3.6 0" stroke="${c}" stroke-width="${ESW}" fill="none" stroke-linecap="round"/>`,
  wink: (x, y, c, right) => right
    ? `<path d="M${x - 1.8} ${y} q1.8 1.7 3.6 0" stroke="${c}" stroke-width="${ESW}" fill="none" stroke-linecap="round"/>`
    : `<circle cx="${x}" cy="${y}" r="1.9" fill="${c}"/>`,
  happy: (x, y, c) => `<path d="M${x - 1.8} ${y + 0.7} q1.8 -2 3.6 0" stroke="${c}" stroke-width="${ESW}" fill="none" stroke-linecap="round"/>`,
}
const EYE_KEYS = Object.keys(EYES)

// Mouths — simple, thick-lined, chunky (MSW), matched to the fat eyes.
const MSW = 1.5
type MouthFn = (spread: number, c: string) => string
const MOUTHS: Record<string, MouthFn> = {
  smile: (s, c) => `<path d="M14.5 ${19 + s}q3.5 2.6 7 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  arc: (s, c) => `<path d="M13.5 ${19 + s} a1,0.85 0 0,0 9,0" fill="${c}"/>`,
  flat: (s, c) => `<path d="M15 ${19.5 + s}h6" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  open: (s, c) => `<circle cx="18" cy="${20 + s}" r="2.3" fill="${c}"/>`,
  grin: (s, c) => `<path d="M13.5 ${18.6 + s}q4.5 3.4 9 0" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  cat: (s, c) => `<path d="M14 ${19 + s}q2 1.8 4 0 q2 1.8 4 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
}
const MOUTH_KEYS = Object.keys(MOUTHS)

// Render a generated beam face to an SVG string for the given seed + palette.
// The wrapper transform mirrors the lib's beam so faces sit identically inside
// the container crop; feature choice is deterministic on the seed hash.
export function renderFaceSvg(seed: string, palette: readonly string[]): string {
  const i = hashSeed(seed)
  const wrapper = pick(i, palette)
  const bg = farthestByLuminance(wrapper, palette)
  const c = ink(wrapper)

  // Small translate only (±2.6px). The lib beam translated up to ±9, which
  // moved the shape's center so far off the canvas center that the wrapper
  // (radius ≈17) stopped covering where the features sit (≈9.5px from center) —
  // features fell outside the shape / got clipped by the circular crop (Gus's
  // "shape doesn't cover the face" / z51). Guarantee coverage: narrowest shape
  // half-extent ≈12.2 (×scale ≥1) minus feature extent 9.5 ≈ 2.7 of slack, so a
  // ≤2.6 offset keeps the whole face inside the wrapper for every shape.
  const tx = ((i % 27) / 26 - 0.5) * 5.2
  const ty = (((digit(i, 2) + digit(i, 5)) % 11) / 10 - 0.5) * 5.2
  // Gentle tilt only (±~12°), not the lib beam's full 0–359° spin. The face
  // rides this rotation (shared transform, below), so a big spin would flip the
  // whole face upside-down — "not even a face anymore". A small tilt keeps every
  // avatar upright and human while still varying per seed.
  const rot = (i % 25) - 12
  const scale = 1 + unit(i, Math.round(C / 12)) / 10

  // Eye spread 0–2 (eyes land at x 12/24 .. 14/22, i.e. ≤6px from center) and
  // the eye row nudged to y=15 (nearer the shape's widest band at center 18).
  // The old 0–4 spread pushed eyes to x 10/24 (±8) — out where the narrower/
  // taller shapes (egg, wide oval, potato) have already tapered, so an eye
  // poked past the edge (z51). Keeping the eye row narrow + centered keeps both
  // eyes on the wrapper for every shape.
  const eyeSpread = i % 3
  const mouthSpread = i % 2

  const shape = SHAPES[SHAPE_KEYS[i % SHAPE_KEYS.length]]
  const eyeFn = EYES[EYE_KEYS[digit(i, 4) % EYE_KEYS.length]]
  const mouthFn = MOUTHS[MOUTH_KEYS[digit(i, 5) % MOUTH_KEYS.length]]

  const wrapperEl = "path" in shape
    ? `<path d="${shape.path}" fill="${wrapper}"/>`
    : `<rect width="${C}" height="${C}" rx="${shape.rect}" fill="${wrapper}"/>`

  const leftEye = eyeFn(14 - eyeSpread, 15, c, false)
  const rightEye = eyeFn(20 + eyeSpread, 15, c, true)
  const mouth = mouthFn(mouthSpread, c)

  // The face is nested inside the shape's transform group and shares its EXACT
  // transform, so features always sit on the wrapper fill, centered on it —
  // never drifting onto the background or off toward an edge. This fixes two
  // bugs at once: (a) "no eyes" — ink is derived from `wrapper`, so a feature
  // that landed on `bg` (now the max-contrast-vs-wrapper color) could match the
  // bg and vanish; keeping features on the wrapper guarantees ink contrast; and
  // (b) "features too far off-center" — the old independent face offset (fx/fy,
  // a lib-beam relic whose wrapper filled the whole 36×36 square) let eyes/mouth
  // wander. Shape and face both rotate about center (18,18) and share the same
  // translate, so the face center coincides with the shape center at any rot.
  // The face rides the shape's rotation (a small tilt, like the lib's own beam).
  const faceXf = `translate(${tx} ${ty}) rotate(${rot} 18 18) scale(${scale})`

  // No <mask> — a full-canvas white mask is a no-op clip, and a shared mask id
  // would collide across the many faces on one page (member lists, message
  // streams). The 36×36 viewBox + the caller's `overflow-hidden` crop already
  // bound the drawing; anything outside the box is clipped by the container.
  return `<svg viewBox="0 0 ${C} ${C}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="${C}" height="${C}" fill="${bg}"/><g transform="${faceXf}">${wrapperEl}${leftEye}${rightEye}${mouth}</g></svg>`
}
