import { slugify } from "@alook/shared"

export type SlugPreview = {
  slug: string

  invalid: boolean

  changed: boolean
}

/**
 * Client-side mirror of what every server/channel name route
 * does server-side (`trim()` then `slugify()`), so the preview shown here
 * is byte-identical to what actually gets stored.
 */
export function previewSlug(name: string): SlugPreview {
  const trimmed = name.trim()
  const slug = slugify(trimmed)
  return {
    slug,
    invalid: trimmed.length > 0 && slug.length === 0,
    changed: slug.length > 0 && slug !== trimmed,
  }
}
