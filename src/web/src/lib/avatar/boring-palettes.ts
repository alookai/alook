/**
 * Color palettes for boring-avatars, chosen deterministically per seed.
 *
 * Set 0 is the official boringavatars.com sample palette; the rest are the
 * opening entries of Matt DesLauriers' Nice Color Palettes (the same source
 * boringavatars.com's own playground samples from). Colors are used as-is for
 * this vibe-check phase — DESIGN.md's desaturation rule is a deliberate
 * follow-up, not applied here.
 *
 * Selection reuses the same hash + mulberry32 PRNG as `gradient-from-seed.ts`
 * so the "looks random, never flickers" behavior matches the rest of the app.
 */

export const PALETTES: readonly (readonly string[])[] = [
  ["#00686c", "#32c2b9", "#edecb3", "#fad928", "#ff9915"],
  ["#69d2e7", "#a7dbd8", "#e0e4cc", "#f38630", "#fa6900"],
  ["#fe4365", "#fc9d9a", "#f9cdad", "#c8c8a9", "#83af9b"],
  ["#ecd078", "#d95b43", "#c02942", "#542437", "#53777a"],
  ["#556270", "#4ecdc4", "#c7f464", "#ff6b6b", "#c44d58"],
  ["#774f38", "#e08e79", "#f1d4af", "#ece5ce", "#c5e0dc"],
  ["#e8ddcb", "#cdb380", "#036564", "#033649", "#031634"],
  ["#490a3d", "#bd1550", "#e97f02", "#f8ca00", "#8a9b0f"],
  ["#594f4f", "#547980", "#45ada8", "#9de0ad", "#e5fcc2"],
  ["#00a0b0", "#6a4a3c", "#cc333f", "#eb6841", "#edc951"],
  ["#e94e77", "#d68189", "#c6a49a", "#c6e5d9", "#f4ead5"],
  ["#3fb8af", "#7fc7af", "#dad8a7", "#ff9e9d", "#ff3d7f"],
  ["#00a8c6", "#40c0cb", "#f9f2e7", "#aee239", "#8fbe00"],
] as const

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One palette from `PALETTES`, chosen deterministically by `seed`. */
export function paletteFromSeed(seed: string): string[] {
  const rand = mulberry32(hashStr(seed))
  const idx = Math.floor(rand() * PALETTES.length)
  return PALETTES[idx] as string[]
}
