// Generated "beam" face renderer — the richer replacement for boring-avatars'
// fixed beam geometry. Ported from the approved design prototype (Alli). Same
// 36-unit canvas, same PRNG + auto-contrast ink as the lib's beam, so it reads
// as "more of the same face", not a new style. The feature vocabulary grew:
//   11 grounded shapes · 21 eyes · 22 mouths.
// Each seed picks its shape/eye/mouth deterministically (INDEPENDENTLY), so a
// given id always renders the same face and never flickers across renames.
//
// TOP-RESERVE: the approved head + ±20° pose leaves a slim top band clear for a
// possible future hat. Hats do not exist in the product today, so this reserve
// follows the QA-approved avatar geometry — the geometry must never be retuned
// to satisfy a speculative accessory constraint (Gus, uiux#609–612).
//
// `beam` only. Marble (server/channel icons, banner) stays on the lib.

const C = 36
const CX = 18
// Head center pushed DOWN to 23.5 (was 18) so the head fills the disc width and
// the chin clips naturally at the bottom, while the CROWN clears the hat band.
// Only the top is reserved — the sides/chin fill the crop like a normal avatar
// (an earlier R=11.2 shrank the whole head to reserve the top → "太小", Gus #99).
const CYh = 23.5
export const FACE_HAT_LINE = 4

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

// Grounded wrapper shapes from the approved component review (uiux#591–593).
// Their lower half shares a sturdy, almost-straight body and a broad rounded
// finish; identity lives in the crown. That keeps every avatar complete when a
// transform exposes more of the bottom without reintroducing sharp stars,
// pinched waists, scalloped chins, or the rejected bump/mushroom silhouettes.
// These path literals are the QA-approved geometry. Do not retune them to make a
// future accessory easier; adapt the accessory/reserve to the avatar instead.
const SHAPES: Record<string, string> = {
  dome: "M2 29V23C2 14.8 8.2 9 17.2 8.2C26.9 7.3 34 13.2 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  loaf: "M2 29V23C2 15.7 6.2 11.2 12.3 10.4C14.5 10.1 15.4 7.1 20.3 7.1C28.5 7.1 34 14.1 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  tall: "M4 29V22C4 12.8 9.5 7 18 7C26.5 7 32 12.8 32 22V29C32 34.2 27.5 37.2 18 37.2C8.5 37.2 4 34.2 4 29Z",
  twin: "M2 29V23C2 16.4 5.8 13.8 10 12.4C9.1 9.1 11.5 7.3 14.2 9.4C16.4 11 19.8 11 22 9.3C24.8 7.1 27.7 9.1 26.8 12.5C31 13.9 34 16.7 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  cloud: "M2 29V23C2 17 5.4 14 9.8 13C9.6 9.5 12.4 7.8 15.1 10C16.2 6.9 20.7 6.9 21.7 10.1C24.8 7.8 28 9.8 27.6 13.2C31.6 14.4 34 17.1 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  block: "M3 29V13C3 9.6 5.7 7.7 9.2 7.7H26.8C30.3 7.7 33 9.6 33 13V29C33 34.2 28.5 37.2 18 37.2C7.5 37.2 3 34.2 3 29Z",
  slope: "M2 29V23C2 15.4 7.2 12 12.7 11.6C15.9 11.3 17.2 8.1 22.5 8.1C29.6 8.1 34 14.4 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  bean: "M2 29V23C2 16.4 5.7 13 10.4 11.8C11.3 8.8 14.2 7.6 17 9.6C19.8 6.9 24.5 7.8 26.2 11.2C31.1 12.6 34 16.5 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  flat: "M2 29V23C2 15.1 8 9.2 15.4 9.2H22.6C29.7 9.2 34 15.1 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  notch: "M2 29V23C2 15.5 7.6 10.6 14.1 9.4C15.5 9.2 16.1 11.8 18 11.8C19.9 11.8 20.5 9.2 21.9 9.4C28.4 10.6 34 15.5 34 23V29C34 34.5 29 37.5 18 37.5C7 37.5 2 34.5 2 29Z",
  squash: "M1.5 29V23C1.5 14.7 8.1 10.2 18 10.2C27.9 10.2 34.5 14.7 34.5 23V29C34.5 34.5 29.2 37.5 18 37.5C6.8 37.5 1.5 34.5 1.5 29Z",
}
const SHAPE_KEYS = Object.keys(SHAPES)
export const FACE_SHAPE_PATHS = Object.values(SHAPES)

// Eyes — bold, rounded, and legible at 32px. Pair-level functions keep gaze,
// asymmetry, and one-eye expressions coherent instead of mixing two half-sets.
const ESW = 1.6
type EyeFn = (spread: number, c: string) => string
const eyeCenters = (spread: number): readonly [number, number] => [14 - spread, 22 + spread]
const oppositeInk = (c: string): string => c === "#000000" ? "#ffffff" : "#000000"
const pupilPair = (spread: number, dxLeft = 0, dxRight = 0, dy = 0): string => {
  const [left, right] = eyeCenters(spread)
  return `<ellipse cx="${left}" cy="20" rx="2.15" ry="2.1" fill="#ffffff"/><circle cx="${left + dxLeft}" cy="${20.25 + dy}" r="1.02" fill="#000000"/><ellipse cx="${right}" cy="20" rx="2.15" ry="2.1" fill="#ffffff"/><circle cx="${right + dxRight}" cy="${20.25 + dy}" r="1.02" fill="#000000"/>`
}
const EYES: Record<string, EyeFn> = {
  bead: (spread, c) => { const [l, r] = eyeCenters(spread); return `<circle cx="${l}" cy="20" r="1.7" fill="${c}"/><circle cx="${r}" cy="20" r="1.7" fill="${c}"/>` },
  wide: (spread) => pupilPair(spread),
  sleepy: (spread, c) => { const [l, r] = eyeCenters(spread); return `<path d="M${l - 2} 20q2 2 4 0M${r - 2} 20q2 2 4 0" fill="none" stroke="${c}" stroke-width="${ESW}" stroke-linecap="round"/>` },
  happy: (spread, c) => { const [l, r] = eyeCenters(spread); return `<path d="M${l - 2} 21q2-2.4 4 0M${r - 2} 21q2-2.4 4 0" fill="none" stroke="${c}" stroke-width="${ESW}" stroke-linecap="round"/>` },
  winkRight: (spread, c) => { const [l, r] = eyeCenters(spread); return `<circle cx="${l}" cy="20" r="1.8" fill="${c}"/><path d="M${r - 2} 20q2 2 4 0" fill="none" stroke="${c}" stroke-width="${ESW}" stroke-linecap="round"/>` },
  winkLeft: (spread, c) => { const [l, r] = eyeCenters(spread); return `<path d="M${l - 2} 20q2 2 4 0" fill="none" stroke="${c}" stroke-width="${ESW}" stroke-linecap="round"/><circle cx="${r}" cy="20" r="1.8" fill="${c}"/>` },
  lookRight: (spread) => pupilPair(spread, 1, 1),
  crossEyed: (spread) => pupilPair(spread, 1, -1),
  lookUp: (spread) => pupilPair(spread, 0, 0, -0.8),
  uneven: (spread, c) => { const [l, r] = eyeCenters(spread); return `<circle cx="${l}" cy="20" r="2.5" fill="#ffffff"/><circle cx="${l}" cy="20.3" r="1.1" fill="#000000"/><circle cx="${r}" cy="20" r="1.45" fill="${c}"/>` },
  oneBig: (spread) => { const [l, r] = eyeCenters(spread); return `<circle cx="${l}" cy="20" r="2.8" fill="#ffffff"/><circle cx="${l}" cy="20.35" r="1.25" fill="#000000"/><circle cx="${r}" cy="20" r="1.65" fill="#ffffff"/><circle cx="${r}" cy="20.2" r="0.8" fill="#000000"/>` },
  bug: (spread) => { const [l, r] = eyeCenters(spread); return `<ellipse cx="${l}" cy="20" rx="1.7" ry="2.55" fill="#ffffff"/><circle cx="${l}" cy="20.5" r="0.9" fill="#000000"/><ellipse cx="${r}" cy="20" rx="1.7" ry="2.55" fill="#ffffff"/><circle cx="${r}" cy="20.5" r="0.9" fill="#000000"/>` },
  glossy: (spread, c) => { const [l, r] = eyeCenters(spread); const detail = oppositeInk(c); return `<circle cx="${l}" cy="20" r="2.2" fill="${c}"/><circle cx="${l - 0.7}" cy="19.3" r="0.65" fill="${detail}"/><circle cx="${r}" cy="20" r="2.2" fill="${c}"/><circle cx="${r - 0.7}" cy="19.3" r="0.65" fill="${detail}"/>` },
  squint: (spread, c) => { const [l, r] = eyeCenters(spread); return `<path d="M${l - 1.5} 20h3M${r - 1.5} 20h3" stroke="${c}" stroke-width="1.9" stroke-linecap="round"/>` },
  closeSet: (_spread, c) => `<circle cx="16" cy="20" r="1.55" fill="${c}"/><circle cx="20" cy="20" r="1.55" fill="${c}"/>`,
  farSet: (_spread, c) => `<circle cx="12.6" cy="20" r="1.55" fill="${c}"/><circle cx="23.4" cy="20" r="1.55" fill="${c}"/>`,
  tallPins: (spread, c) => { const [l, r] = eyeCenters(spread); return `<ellipse cx="${l}" cy="20" rx="1.25" ry="2.15" fill="${c}"/><ellipse cx="${r}" cy="20" rx="1.25" ry="2.15" fill="${c}"/>` },
  halfLid: (spread) => { const [l, r] = eyeCenters(spread); return `<ellipse cx="${l}" cy="20" rx="2.2" ry="2" fill="#ffffff"/><circle cx="${l}" cy="20.55" r="1" fill="#000000"/><ellipse cx="${r}" cy="20" rx="2.2" ry="2" fill="#ffffff"/><circle cx="${r}" cy="20.55" r="1" fill="#000000"/><path d="M${l - 2.2} 19.1h4.4M${r - 2.2} 19.1h4.4" stroke="#000000" stroke-width="1.35" stroke-linecap="round"/>` },
  droopy: (spread) => { const [l, r] = eyeCenters(spread); return `<ellipse cx="${l}" cy="20" rx="2.1" ry="2.45" fill="#ffffff" transform="rotate(-8 ${l} 20)"/><circle cx="${l + 0.25}" cy="20.65" r="1" fill="#000000"/><ellipse cx="${r}" cy="20" rx="2.1" ry="2.45" fill="#ffffff" transform="rotate(8 ${r} 20)"/><circle cx="${r - 0.25}" cy="20.65" r="1" fill="#000000"/>` },
  rings: (spread, c) => { const [l, r] = eyeCenters(spread); return `<circle cx="${l}" cy="20" r="1.8" fill="none" stroke="${c}" stroke-width="1.25"/><circle cx="${r}" cy="20" r="1.8" fill="none" stroke="${c}" stroke-width="1.25"/>` },
  wobble: (spread, c) => { const [l, r] = eyeCenters(spread); return `<circle cx="${l}" cy="19.4" r="1.7" fill="${c}"/><circle cx="${r}" cy="20.6" r="1.7" fill="${c}"/>` },
}
const EYE_KEYS = Object.keys(EYES)

// Mouths — simple, thick-lined, chunky (MSW), matched to the fat eyes. Anchored
// at the head center (y ≈ 24, below the eyes at 20), inside every shape.
const MSW = 1.5
type MouthFn = (spread: number, c: string) => string
const MOUTHS: Record<string, MouthFn> = {
  soft: (s, c) => `<path d="M14.5 ${24.2 + s}q3.5 2.6 7 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  tinySmile: (s, c) => `<path d="M16.2 ${24.5 + s}q1.8 1.5 3.6 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  bigSmile: (s, c) => `<path d="M13.2 ${23.8 + s}q4.8 4 9.6 0" stroke="${c}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`,
  flat: (s, c) => `<path d="M15 ${24.5 + s}h6" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  smirk: (s, c) => `<path d="M15 ${25 + s}q3.5 0.7 6-1.2" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  crooked: (s, c) => `<path d="M14.5 ${25 + s}q2.2-1.6 4 0.1q1.6 1.4 3-0.4" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  pout: (s, c) => `<path d="M14.5 ${26 + s}q3.5-2.5 7 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  deepFrown: (s, c) => `<path d="M13.8 ${26.4 + s}q4.2-3.8 8.4 0" stroke="${c}" stroke-width="1.65" fill="none" stroke-linecap="round"/>`,
  open: (s, c) => `<circle cx="18" cy="${25 + s}" r="2.3" fill="${c}"/>`,
  gasp: (s, c) => `<ellipse cx="18" cy="${25 + s}" rx="2.05" ry="3.05" fill="${c}"/>`,
  ooh: (s, c) => `<ellipse cx="18" cy="${25 + s}" rx="1.55" ry="2.3" fill="none" stroke="${c}" stroke-width="1.45"/>`,
  grin: (s, c) => `<path d="M13.7 ${23.8 + s}q4.3 3.8 8.6 0q-0.4 4.2-4.3 4.2t-4.3-4.2Z" fill="${oppositeInk(c)}" stroke="${c}" stroke-width="1.15" stroke-linejoin="round"/>`,
  bigGrin: (s, c) => `<rect x="12.8" y="${23.8 + s}" width="10.4" height="5.2" rx="2.6" fill="${c}"/><path d="M14.3 ${25 + s}q3.7 1.8 7.4 0" fill="none" stroke="${oppositeInk(c)}" stroke-width="1.5" stroke-linecap="round"/>`,
  cat: (s, c) => `<path d="M14 ${24 + s}q2 1.8 4 0 q2 1.8 4 0" stroke="${c}" stroke-width="${MSW}" fill="none" stroke-linecap="round"/>`,
  littleW: (s, c) => `<path d="M15 ${24.2 + s}q1.5 2 3 0q1.5 2 3 0" stroke="${c}" stroke-width="1.65" fill="none" stroke-linecap="round"/>`,
  underbite: (s, c) => `<rect x="14.3" y="${23.8 + s}" width="7.4" height="4.8" rx="2.4" fill="${c}"/><rect x="16.2" y="${26.25 + s}" width="1.8" height="1.55" rx="0.5" fill="${oppositeInk(c)}"/><rect x="18" y="${26.25 + s}" width="1.8" height="1.55" rx="0.5" fill="${oppositeInk(c)}"/>`,
  tongue: (s, c) => `<rect x="14.3" y="${23.6 + s}" width="7.4" height="5" rx="2.5" fill="${c}"/><ellipse cx="18" cy="${27 + s}" rx="2" ry="1.2" fill="${oppositeInk(c)}"/>`,
  sideTongue: (s, c) => `<rect x="14.3" y="${23.6 + s}" width="7.4" height="5" rx="2.5" fill="${c}"/><ellipse cx="19.3" cy="${27.1 + s}" rx="1.8" ry="1.15" fill="${oppositeInk(c)}" transform="rotate(-12 19.3 ${27.1 + s})"/>`,
  gummy: (s, c) => `<rect x="14.2" y="${23.7 + s}" width="7.6" height="4.9" rx="2.45" fill="${c}"/><rect x="18.1" y="${24.05 + s}" width="1.75" height="1.8" rx="0.5" fill="${oppositeInk(c)}"/>`,
  chew: (s, c) => `<rect x="15" y="${23.7 + s}" width="6.6" height="3.2" rx="1.6" fill="${c}"/><circle cx="16.5" cy="${25.25 + s}" r="0.7" fill="${oppositeInk(c)}"/>`,
  kiss: (s, c) => `<path d="M15.3 ${24.8 + s}q1.4-1.8 2.7-0.4q1.3-1.4 2.7 0.4q-1.1 1.8-2.7 1.8t-2.7-1.8Z" fill="${c}"/>`,
  bubble: (s, c) => `<circle cx="18.8" cy="${25 + s}" r="1.6" fill="${c}"/><circle cx="16" cy="${24.5 + s}" r="0.65" fill="${c}"/>`,
}
const MOUTH_KEYS = Object.keys(MOUTHS)

export const FACE_VOCABULARY = {
  shapes: SHAPE_KEYS.length,
  eyes: EYE_KEYS.length,
  mouths: MOUTH_KEYS.length,
  combinations: SHAPE_KEYS.length * EYE_KEYS.length * MOUTH_KEYS.length,
} as const

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
  // 11×21×22 space. Radix slicing gives each feature its own uniform,
  // decorrelated index regardless of vocabulary size.
  const shapePath = SHAPES[SHAPE_KEYS[i % SHAPE_KEYS.length]]
  const eyeFn = EYES[EYE_KEYS[Math.floor(i / SHAPE_KEYS.length) % EYE_KEYS.length]]
  const mouthFn = MOUTHS[MOUTH_KEYS[Math.floor(i / (SHAPE_KEYS.length * EYE_KEYS.length)) % MOUTH_KEYS.length]]

  // Per-seed variation, all BOUNDED so the crown-reserve bound above holds:
  //   tilt ±20°, scale-about-center 0.98–1.02, horizontal nudge tx free, and
  //   ty DOWNWARD ONLY (0..+1.6). No upward nudge: the lowest approved crown
  //   control-points intentionally keep only a small hat-band margin. Down is
  //   always safe (the fully rounded chin simply clips further off-canvas).
  const rot = (i % 41) - 20
  const scale = 1 + unit(i, 3) / 100
  const tx = ((i % 27) / 26 - 0.5) * 4.0
  const ty = ((digit(i, 3) % 5) / 4) * 1.6

  // Eyes at y20, mouth ~y24 — a normal face layout around the head center 23.5.
  // Eye spread 0–1 (x 13/23 .. 14/22, ≤5px from center): narrow + centered keeps
  // both eyes on the wrapper for every shape (guards z51: never poke past edge).
  const eyeSpread = i % 2
  const mouthSpread = i % 2

  const wrapperEl = `<path d="${shapePath}" fill="${wrapper}"/>`
  const eyes = eyeFn(eyeSpread, c)
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
  return `<svg viewBox="0 0 ${C} ${C}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><rect width="${C}" height="${C}" fill="${bg}"/><g transform="${faceXf}">${wrapperEl}${eyes}${mouth}</g></svg>`
}
