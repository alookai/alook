export const OG_TITLE_MAX_LINES = 2
export const OG_TITLE_LINE_CLAMP = `${OG_TITLE_MAX_LINES} "…"`
export const OG_TITLE_MAX_INPUT_GRAPHEMES = 240

type OgTitleFontSize = 38 | 44 | 52

export const OG_TITLE_MAX_DISPLAY_UNITS: Record<OgTitleFontSize, number> = {
  52: 50,
  44: 60,
  38: 68,
}

const OG_TITLE_LINE_UNITS: Record<OgTitleFontSize, number> = {
  52: 25,
  44: 30,
  38: 34,
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" })
const FULL_WIDTH_GRAPHEME = /[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]|[\u{1f300}-\u{1faff}]/u
const WIDE_DISPLAY_GRAPHEME = /[A-Zmw]|[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]|[\u{1f300}-\u{1faff}]/u

export type OgTitlePresentation = {
  displayTitle: string
  fontSize: number
  lineClamp: string
  maxHeight: number
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

export function getOgTitleVisualUnits(title: string): number {
  return splitGraphemes(title).reduce(
    (total, grapheme) => total + (WIDE_DISPLAY_GRAPHEME.test(grapheme) ? 2 : 1),
    0,
  )
}

function getOgTitleSizingUnits(title: string): number {
  return splitGraphemes(title).reduce(
    (total, grapheme) => total + (FULL_WIDTH_GRAPHEME.test(grapheme) ? 2 : 1),
    0,
  )
}

function fitsOgTitle(title: string, fontSize: OgTitleFontSize): boolean {
  const lineUnits = OG_TITLE_LINE_UNITS[fontSize]
  let lines = 1
  let usedUnits = 0

  for (const word of title.split(" ")) {
    const wordUnits = getOgTitleVisualUnits(word)
    const separatorUnits = usedUnits > 0 ? 1 : 0
    if (separatorUnits + wordUnits <= lineUnits - usedUnits) {
      usedUnits += separatorUnits + wordUnits
      continue
    }

    if (usedUnits > 0) {
      lines += 1
      usedUnits = 0
    }

    lines += Math.floor(Math.max(0, wordUnits - 1) / lineUnits)
    usedUnits = wordUnits === 0 ? 0 : ((wordUnits - 1) % lineUnits) + 1
    if (lines > OG_TITLE_MAX_LINES) return false
  }

  return lines <= OG_TITLE_MAX_LINES
}

function truncateOgTitleForDisplay(title: string, fontSize: OgTitleFontSize): string {
  if (fitsOgTitle(title, fontSize)) return title

  const kept: string[] = []
  for (const grapheme of splitGraphemes(title)) {
    const candidate = `${kept.join("")}${grapheme}`.trimEnd()
    if (!fitsOgTitle(`${candidate}…`, fontSize)) break
    kept.push(grapheme)
  }

  return `${kept.join("").trimEnd()}…`
}

export function getOgTitlePresentation(title: string): OgTitlePresentation {
  const normalizedTitle = normalizeOgTitle(title)
  const sizingUnits = getOgTitleSizingUnits(normalizedTitle)
  let fontSize: OgTitleFontSize = sizingUnits <= 56 ? 52 : sizingUnits <= 112 ? 44 : 38
  if (fontSize === 52 && !fitsOgTitle(normalizedTitle, 52)) fontSize = 44

  return {
    displayTitle: truncateOgTitleForDisplay(normalizedTitle, fontSize),
    fontSize,
    lineClamp: OG_TITLE_LINE_CLAMP,
    maxHeight: Math.ceil(fontSize * 1.15 * OG_TITLE_MAX_LINES),
  }
}
