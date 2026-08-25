export const OG_TITLE_MAX_LINES = 2
export const OG_TITLE_LINE_CLAMP = `${OG_TITLE_MAX_LINES} "…"`
export const OG_TITLE_MAX_INPUT_GRAPHEMES = 240
export const OG_TITLE_FONT_SIZE = 52
export const OG_TITLE_MAX_HEIGHT = Math.ceil(
  OG_TITLE_FONT_SIZE * 1.15 * OG_TITLE_MAX_LINES,
)

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" })

function splitGraphemes(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment)
}

export function normalizeOgTitle(title: string): string {
  const compact = title.trim().replace(/\s+/gu, " ")
  const graphemes = splitGraphemes(compact)
  if (graphemes.length <= OG_TITLE_MAX_INPUT_GRAPHEMES) return compact

  return `${graphemes.slice(0, OG_TITLE_MAX_INPUT_GRAPHEMES - 1).join("")}…`
}
