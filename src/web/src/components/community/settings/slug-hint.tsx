import type { SlugPreview } from "@/lib/community/slug-preview"

export function SlugHint({ slug, invalid, changed }: SlugPreview) {
  if (invalid) {
    return (
      <p className="mt-1.5 text-xs text-destructive">
        Add a character other than space, / or # to save this name
      </p>
    )
  }
  if (!changed) return null
  return (
    <p className="mt-1.5 text-xs text-muted-foreground">
      Will be saved as <span className="font-medium text-foreground">{slug}</span>
    </p>
  )
}
