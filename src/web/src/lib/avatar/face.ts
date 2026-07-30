// Generated "beam" face renderer — the richer replacement for boring-avatars'
// fixed beam geometry. Ported from the approved design prototype (Alli). Same
// 36-unit canvas, same PRNG + auto-contrast ink as the lib's beam, so it reads
// as "more of the same face", not a new style. The feature vocabulary grew:
//   8 shapes (silhouette-distinct) · 6 eyes · 6 mouths.
// Each seed picks its shape/eye/mouth deterministically (INDEPENDENTLY), so a
// given id always renders the same face and never flickers across renames.
//
// TOP-RESERVE: the head sits in the LOWER band of the canvas, leaving the top
// ~20% (y ≤ HAT_LINE) clear for a future hat system — a hat must be able to sit
// ABOVE the crown ("头的最高点不能超过帽子"). The crown is guaranteed ≥ HAT_LINE
// for every shape under every random tilt/scale/nudge (see the closed-form
// bound + brute-force check in the design harness).
//
// `beam` only. Marble (server/channel icons, banner) stays on the lib.

const C = 36
const CX = 18
// Head center pushed DOWN to 23.5 (was 18) so the head fills the disc width and
// the chin clips naturally at the bottom, while the CROWN clears the hat band.
// Only the top is reserved — the sides/chin fill the crop like a normal avatar
// (an earlier R=11.2 shrank the whole head to reserve the top → "太小", Gus #99).
const CYh = 23.5
// Base head radius. Solved from the reserve constraint alone: worst-case crown =
// CYh − sMax·R·maxMod ≥ HAT_LINE. With maxMod≈1.10 (fattest shape), sMax=1.02,
// HAT_LINE=7.2 → R ≤ 14.45. That fills ~80% of the disc at the widest band
// (matches the lib's beam presence), chin clips off-canvas at the bottom.
const R = 14.45
const HAT_LINE = 7.2
const TAU = Math.PI * 2
// Dense sampling — the 8 shapes include 5-lobed stars; too few points and the
// lobes flatten into a blob. 200 keeps the silhouette crisp at any render size.
const N = 200

// boring-avatars PRNG helpers (verbatim from the lib bundle, so the base
// transform matches the lib's beam feel exactly).
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

// A closed radial curve r(a) = R * mod(a) about the head center (CX, CYh).
function polyPath(mod: (a: number) => number): string {
  let d = ""
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * TAU
    const r = R * mod(a)
    const x = CX + r * Math.cos(a)
    const y = CYh + r * Math.sin(a)
    d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " "
  }
  return d + "Z"
}
// Superellipse radius at angle a — a soft rounded-square (n≈3), the "rounded"
// silhouette without literal corners (a <rect> can't be used: under the
// circular avatar crop a full-canvas rect fills the whole crop top, leaving no
// room to reserve the hat band, and its corners poke straight up under tilt).
const superell = (a: number, n: number): number =>
  1 / Math.pow(Math.pow(Math.abs(Math.cos(a)), n) + Math.pow(Math.abs(Math.sin(a)), n), 1 / n)

// Wrapper shapes: soft, chunky, distinct by SILHOUETTE (proportion + gentle
// asymmetry), not corner-radius — corner differences vanish at 32px under the
// circular crop. All are bounded radial curves: a radial shape's max radius is
// rotation-invariant, so tilt never pushes the crown higher than the closed-
// form bound — that's what lets the hat reserve hold under every random tilt.
// The three lobed shapes (clover/trilobe/star5) use Alli's approved formulas
// (uiux#87) verbatim; do not retune the coefficients.
const SHAPES: Record<string, (a: number) => number> = {
  round: () => 1,
  rounded: (a) => superell(a, 3.2) * 0.95,
  wide: (a) => Math.hypot(1.06 * Math.cos(a), 0.74 * Math.sin(a)),
  potato: (a) => 0.95 * (1 + 0.11 * Math.sin(a + 0.5) + 0.06 * Math.cos(2 * a - 0.8)),
  drop: (a) => 0.94 * (1 + 0.14 * Math.cos(a - Math.PI / 2)),
  clover: (a) => 0.8 * (1 + 0.17 * Math.cos(4 * a)),
  trilobe: (a) => 0.86 * (1 + 0.14 * Math.cos(3 * a - Math.PI / 2)),
  star5: (a) => 0.8 * (1 + 0.15 * Math.cos(5 * a - Math.PI / 2)),
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

// Mouths — simple, thick-lined, chunky (MSW), matched to the fat eyes. Anchored
// at the head center (y ≈ 24, below the eyes at 20), inside every shape.
const MSW = 1.5
type MouthFn = (spread: number, c: string) => string
const MOUTHS: Record<string, MouthFn> = {
  smile: (s, c) => `<path d="M14.5 ${24 + s}q3.5 2.6 7 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  arc: (s, c) => `<path d="M13.5 ${24 + s} a1,0.85 0 0,0 9,0" fill="${c}"/>`,
  flat: (s, c) => `<path d="M15 ${24.5 + s}h6" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  open: (s, c) => `<circle cx="18" cy="${25 + s}" r="2.3" fill="${c}"/>`,
  grin: (s, c) => `<path d="M13.5 ${23.6 + s}q4.5 3.4 9 0" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  cat: (s, c) => `<path d="M14 ${24 + s}q2 1.8 4 0 q2 1.8 4 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
}
const MOUTH_KEYS = Object.keys(MOUTHS)

// Render a generated beam face to an SVG string for the given seed + palette.
// Feature choice is deterministic on the seed hash; the head is placed in the
// lower band so the top ~20% stays clear for a hat.
export function renderFaceSvg(seed: string, palette: readonly string[]): string {
  const i = hashSeed(seed)
  const wrapper = pick(i, palette)
  const bg = farthestByLuminance(wrapper, palette)
  const c = ink(wrapper)

  // INDEPENDENT feature selection via radix slicing of the hash. The old code
  // used i%len for shape but digit(i,4)%6 / digit(i,5)%6 for eye/mouth — a
  // single 0–9 digit %6 makes idx 4/5 (wink/happy, grin/cat) only ~10% each
  // (non-uniform), and coupling all three to the same source collapses the
  // 8×6×6 space. Radix slicing gives each feature its own uniform, decorrelated
  // index: shape = i mod 8, eye = (i/8) mod 6, mouth = (i/48) mod 6.
  const shapeFn = SHAPES[SHAPE_KEYS[i % SHAPE_KEYS.length]]
  const eyeFn = EYES[EYE_KEYS[Math.floor(i / SHAPE_KEYS.length) % EYE_KEYS.length]]
  const mouthFn = MOUTHS[MOUTH_KEYS[Math.floor(i / (SHAPE_KEYS.length * EYE_KEYS.length)) % MOUTH_KEYS.length]]

  // Per-seed variation, all BOUNDED so the crown-reserve bound above holds:
  //   tilt ±8°, scale-about-center 0.98–1.02, horizontal nudge tx free, and
  //   ty DOWNWARD ONLY (0..+1.6). No upward nudge: with the enlarged head the
  //   crown bound (CYh − sMax·R·maxMod ≈ 7.34) has almost no top slack, so any
  //   upward shift would poke into the hat band. Down is always safe (chin just
  //   clips further off-canvas).
  const rot = (i % 17) - 8
  const scale = 1 + unit(i, 3) / 100
  const tx = ((i % 27) / 26 - 0.5) * 4.0
  const ty = ((digit(i, 3) % 5) / 4) * 1.6

  // Eyes at y20, mouth ~y24 — a normal face layout around the head center 23.5.
  // Eye spread 0–1 (x 13/23 .. 14/22, ≤5px from center): narrow + centered keeps
  // both eyes on the wrapper for every shape (guards z51: never poke past edge).
  const eyeSpread = i % 2
  const mouthSpread = i % 2

  const wrapperEl = `<path d="${polyPath(shapeFn)}" fill="${wrapper}"/>`
  const leftEye = eyeFn(14 - eyeSpread, 20, c, false)
  const rightEye = eyeFn(22 + eyeSpread, 20, c, true)
  const mouth = mouthFn(mouthSpread, c)

  // The face is nested inside the head's transform group and shares its EXACT
  // transform, so features always sit on the wrapper fill, centered on it. Both
  // shape and features scale + rotate ABOUT THE HEAD CENTER (CX, CYh) — scaling
  // about the origin (the old bug) would displace the whole head off-center and
  // break the reserve bound. Order (SVG applies right-to-left): scale about
  // center, then rotate about center, then translate.
  const faceXf = `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${rot} ${CX} ${CYh}) translate(${(CX * (1 - scale)).toFixed(2)} ${(CYh * (1 - scale)).toFixed(2)}) scale(${scale.toFixed(3)})`

  // No <mask> — a full-canvas white mask is a no-op clip, and a shared mask id
  // would collide across the many faces on one page (member lists, message
  // streams). The 36×36 viewBox + the caller's `overflow-hidden` crop already
  // bound the drawing; anything outside the box is clipped by the container.
  return `<svg viewBox="0 0 ${C} ${C}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="${C}" height="${C}" fill="${bg}"/><g transform="${faceXf}">${wrapperEl}${leftEye}${rightEye}${mouth}</g></svg>`
}
