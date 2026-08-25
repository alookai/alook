export const OG_TITLE_MAX_LINES = 2
export const OG_TITLE_LINE_CLAMP = `${OG_TITLE_MAX_LINES} "…"`

export type OgTitlePresentation = {
  fontSize: number
  lineClamp: string
}

export function getOgTitlePresentation(title: string): OgTitlePresentation {
  const length = Array.from(title).length

  return {
    fontSize: length <= 56 ? 52 : length <= 112 ? 44 : 38,
    lineClamp: OG_TITLE_LINE_CLAMP,
  }
}
