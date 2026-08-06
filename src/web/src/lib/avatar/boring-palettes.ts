/**
 * Color palettes for boring-avatars, chosen deterministically per seed.
 *
 * Set 0 is the official boringavatars.com sample palette. Sets 1–12 began from
 * opening entries of Matt DesLauriers' Nice Color Palettes (the same source the
 * boringavatars.com playground samples from), with three muddy/clashing entries
 * replaced by curated sets. Sets 13–24 are Alook's approved expansion: each has
 * a deliberate dark anchor, bright body hues, and a light relief color so every
 * generated wrapper can find a readable background. No global desaturation: it
 * dropped contrast, so the vibrant hues stand.
 *
 * Selection reuses the same hash + mulberry32 PRNG as `gradient-from-seed.ts`
 * so the "looks random, never flickers" behavior matches the rest of the app.
 */

export const PALETTES: readonly (readonly string[])[] = [
  ["#00686c", "#32c2b9", "#edecb3", "#fad928", "#ff9915"],
  ["#69d2e7", "#a7dbd8", "#e0e4cc", "#f38630", "#fa6900"],
  ["#fe4365", "#fc9d9a", "#f9cdad", "#c8c8a9", "#83af9b"],
  ["#ffd166", "#f4845f", "#ef476f", "#c86b98", "#6a8caf"],
  ["#556270", "#4ecdc4", "#c7f464", "#ff6b6b", "#c44d58"],
  ["#774f38", "#e08e79", "#f1d4af", "#ece5ce", "#c5e0dc"],
  ["#0b525b", "#06d6a0", "#8ac6d1", "#ffd166", "#ff9f68"],
  ["#3a2e4d", "#8a5a9e", "#e0729a", "#ffb26b", "#ffe08a"],
  ["#594f4f", "#547980", "#45ada8", "#9de0ad", "#e5fcc2"],
  ["#00a0b0", "#6a4a3c", "#cc333f", "#eb6841", "#edc951"],
  ["#e94e77", "#d68189", "#c6a49a", "#c6e5d9", "#f4ead5"],
  ["#3fb8af", "#7fc7af", "#dad8a7", "#ff9e9d", "#ff3d7f"],
  ["#00a8c6", "#40c0cb", "#f9f2e7", "#aee239", "#8fbe00"],
  ["#23352f", "#7bc95a", "#dce95c", "#ffd65a", "#fff1b8"],
  ["#17394a", "#35aeb4", "#77d9d5", "#b9eff0", "#f3d978"],
  ["#3e233d", "#8b4771", "#dc6b9d", "#ff9fb3", "#ffe1dd"],
  ["#4a2e25", "#d6664c", "#f58c64", "#ffc173", "#ffe2ad"],
  ["#24372e", "#55744f", "#90aa62", "#c8d685", "#f0efc0"],
  ["#25294f", "#4d5c9a", "#7587d6", "#a9b6ff", "#ebe9ff"],
  ["#493044", "#eb7c8b", "#ffb46d", "#ffe08b", "#c8ecdc"],
  ["#3c302b", "#8d5d4d", "#c27f65", "#e7ae85", "#f3dfc7"],
  ["#16202a", "#32d48e", "#c4f342", "#ffdf3f", "#ff7597"],
  ["#17192e", "#3f477f", "#7457a8", "#c47edb", "#f3c8ef"],
  ["#362a52", "#7d60a9", "#b699dc", "#dfc7f0", "#fff0d9"],
  ["#432526", "#c6403f", "#f0654b", "#ffab62", "#ffe0a6"],
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
