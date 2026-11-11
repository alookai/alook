/**
 * Profile-card banner in a comic-print style (Gus, gus-uiux #3235–#3238).
 * Each person draws one of three patterns — ink bands, sunburst or Ben-Day dots —
 * plus their own palette, angle and proportions, so two cards rarely look alike.
 * Output is a CSS `background` value; the same seed always gives the same banner.
 */

const INK = "#1f1a15"

// Flat, saturated, slightly warm inks, like four-colour newsprint.
const INKS = {
  red: "#e8402f", yellow: "#ffd23a", cyan: "#27b3e8", magenta: "#f0479a", blue: "#3157d6",
  green: "#2fbf71", orange: "#ff8a1f", cream: "#fff3d6", purple: "#8d4fd6",
} as const

type InkName = keyof typeof INKS

const PALETTES: ReadonlyArray<readonly [InkName, InkName, InkName]> = [
  ["red", "yellow", "blue"], ["cyan", "magenta", "yellow"], ["orange", "blue", "cream"], ["green", "yellow", "red"],
  ["magenta", "cyan", "cream"], ["blue", "orange", "yellow"], ["purple", "yellow", "cyan"], ["red", "cream", "cyan"],
  ["yellow", "magenta", "blue"], ["green", "purple", "cream"],
]

export type ProfileBannerPattern = "bands" | "burst" | "benday"
export const PROFILE_BANNER_PATTERNS: readonly ProfileBannerPattern[] = ["bands", "burst", "benday"]

/** FNV-1a with a murmur3 finaliser: nearby seeds land far apart. */
function bannerHash(text: string): number {
  let hash = 0x811c9dc5
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193)
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

/** Deterministic [0, 1) stream for one seed and pattern. */
function stream(text: string): () => number {
  let state = bannerHash(text) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 100_000) / 100_000
  }
}

function palette(next: () => number): readonly [string, string, string] {
  const names = PALETTES[Math.floor(next() * PALETTES.length)]
  return [INKS[names[0]], INKS[names[1]], INKS[names[2]]]
}

function halftone(color: string, cell: number, ratio: number): string {
  const radius = Math.round(cell * ratio)
  return `radial-gradient(circle, ${color} ${radius}px, transparent ${radius + 0.6}px) 0 0 / ${cell}px ${cell}px`
}

/** Uneven ink-outlined bands at a wide angle range, under a light dot screen. */
function bands(seed: string): string {
  const next = stream(`${seed}:bands`)
  const colors = palette(next)
  const angle = Math.round((next() * 2 - 1) * 70)
  const line = 3
  const count = 3 + Math.floor(next() * 3)
  const stops: string[] = []
  let position = 0
  for (let index = 0; index < count; index++) {
    const width = 10 + Math.round(next() * 30)
    stops.push(`${INK} ${position}px ${position + line}px`, `${colors[index % colors.length]} ${position + line}px ${position + line + width}px`)
    position += line + width
  }
  return `${halftone("rgb(31 26 21 / 22%)", 6, 0.32)}, repeating-linear-gradient(${angle}deg, ${stops.join(", ")})`
}

/** Rays from an origin that may sit off the banner; ray count and width vary. */
function burst(seed: string): string {
  const next = stream(`${seed}:burst`)
  const colors = palette(next)
  const count = 10 + Math.floor(next() * 10)
  const step = 360 / count
  const x = Math.round(next() * 100)
  const y = Math.round(-40 + next() * 180)
  const ray = step * (0.3 + next() * 0.3)
  const from = Math.round(next() * 360)
  const edge = 1.6
  const rays = `repeating-conic-gradient(from ${from}deg at ${x}% ${y}%, ${colors[0]} 0deg ${ray.toFixed(2)}deg, ${INK} ${ray.toFixed(2)}deg ${(ray + edge).toFixed(2)}deg, ${colors[1]} ${(ray + edge).toFixed(2)}deg ${(step - edge).toFixed(2)}deg, ${INK} ${(step - edge).toFixed(2)}deg ${step.toFixed(2)}deg)`
  return `${halftone("rgb(31 26 21 / 26%)", 7, 0.32)}, ${rays}`
}

/** A flat field, big Ben-Day dots in a second ink and one ink-outlined action slash. */
function benday(seed: string): string {
  const next = stream(`${seed}:benday`)
  const colors = palette(next)
  const cell = 9 + Math.floor(next() * 5)
  const angle = Math.round(-50 + next() * 100)
  const start = 20 + Math.round(next() * 60)
  const end = start + 10 + Math.round(next() * 14)
  const slash = `linear-gradient(${angle}deg, transparent ${start}%, ${INK} ${start}%, ${INK} calc(${start}% + 3px), ${colors[2]} calc(${start}% + 3px), ${colors[2]} calc(${end}% - 3px), ${INK} calc(${end}% - 3px), ${INK} ${end}%, transparent ${end}%)`
  return `${slash}, ${halftone(colors[1], cell, 0.42)}, ${colors[0]}`
}

const RENDERERS: Record<ProfileBannerPattern, (seed: string) => string> = { bands, burst, benday }

export function profileBannerPattern(seed: string): ProfileBannerPattern {
  return PROFILE_BANNER_PATTERNS[bannerHash(`${seed}:style`) % PROFILE_BANNER_PATTERNS.length]
}

export function profileBannerBackground(seed: string): string {
  return RENDERERS[profileBannerPattern(seed)](seed)
}
