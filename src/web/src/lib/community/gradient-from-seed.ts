/**
 * Deterministic fallback gradient, seeded by a stable id.
 *
 * Draws three distinct colors (and a gradient angle) from the same preset
 * palette used by the agent avatar generator (`BG_COLORS`) so every fallback
 * visual — server icons, the profile-card banner — shares one design
 * language. Everything is seeded, so it looks random across ids but never
 * flickers between renders/reloads.
 */
import { BG_COLORS } from "@/components/avatar/avatar-parts"

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// mulberry32 — small, fast seeded PRNG. A raw `hash % length` would bias
// consecutive picks toward nearby indices; this gives an even spread.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Three distinct preset colors from `BG_COLORS`, seeded by `seed`. */
export function gradientColorsFromSeed(seed: string): [string, string, string] {
  const rand = mulberry32(hashStr(seed))
  const pool = BG_COLORS.map((c) => c.value)
  const picked: string[] = []
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const idx = Math.floor(rand() * pool.length)
    picked.push(pool.splice(idx, 1)[0]!)
  }
  return picked as [string, string, string]
}

// Salted separately from the color pick so the angle doesn't move in lockstep
// with color choice (two seeds with the same colors can still differ).
export function gradientAngleFromSeed(seed: string): number {
  const rand = mulberry32(hashStr(`${seed}:angle`))
  return Math.floor(rand() * 360)
}

/** CSS `background` value for a seeded fallback gradient. */
export function gradientFromSeed(seed: string): string {
  const [c0, c1, c2] = gradientColorsFromSeed(seed)
  const angle = gradientAngleFromSeed(seed)
  return `linear-gradient(${angle}deg, ${c0}, ${c1}, ${c2})`
}
