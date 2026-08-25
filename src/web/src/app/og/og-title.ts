export const OG_TITLE_MAX_LINES = 2
export const OG_TITLE_LINE_CLAMP = `${OG_TITLE_MAX_LINES} "…"`
export const OG_TITLE_MAX_INPUT_GRAPHEMES = 240

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" })
const WIDE_GRAPHEME = /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]|[\u{1f300}-\u{1faff}]/u

export type OgTitlePresentation = {
  fontSize: number
  lineClamp: string
}

function splitGraphemes(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment)
}

export function normalizeOgTitle(title: string): string {
  const compact = title.trim().replace(/\s+/gu, " ")
  const graphemes = splitGraphemes(compact)
  if (graphemes.length <= OG_TITLE_MAX_INPUT_GRAPHEMES) return compact

  return `${graphemes.slice(0, OG_TITLE_MAX_INPUT_GRAPHEMES - 1).join("")}…`
}

export function getOgTitlePresentation(title: string): OgTitlePresentation {
  const visualUnits = splitGraphemes(title).reduce(
    (total, grapheme) => total + (WIDE_GRAPHEME.test(grapheme) ? 2 : 1),
    0,
  )

  return {
    fontSize: visualUnits <= 56 ? 52 : visualUnits <= 112 ? 44 : 38,
    lineClamp: OG_TITLE_LINE_CLAMP,
  }
}
