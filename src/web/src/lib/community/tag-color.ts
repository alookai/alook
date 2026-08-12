import type { CSSProperties } from "react"

const TAG_HUES = [8, 30, 55, 95, 145, 175, 205, 250, 290, 330] as const

export function tagHue(tag: string): number {
  let hash = 5381
  for (const character of tag) {
    hash = ((hash << 5) + hash + character.charCodeAt(0)) >>> 0
  }
  return TAG_HUES[hash % TAG_HUES.length]
}

export function tagColorStyle(tag: string): CSSProperties {
  return { "--forum-tag-hue": tagHue(tag) } as CSSProperties
}

export const tagColorClassName = "forum-tag-color"
