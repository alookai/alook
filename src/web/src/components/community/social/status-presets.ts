/**
 * Preset status terms (emoji + short term) offered by `StatusEditor`, plus
 * the shared "is a status set" predicate every display surface uses.
 *
 * Tone is deliberately casual/fun, not work-mode — see plans/profile-card.md.
 */
export type StatusPreset = { emoji: string; text: string }

export const STATUS_PRESETS: StatusPreset[] = [
  { emoji: "🎧", text: "Vibing" },
  { emoji: "🎮", text: "Gaming" },
  { emoji: "🦥", text: "Chillin'" },
  { emoji: "🍟", text: "Snack break" },
  { emoji: "📞", text: "On a call" },
  { emoji: "🚪", text: "Afk" },
  { emoji: "😴", text: "Do not disturb" },
]

/**
 * The emoji and term can be set semi-independently (the emoji picker can
 * override the emoji without touching the term), so "does this user have a
 * status" must check both fields — not `statusText` truthiness alone (a
 * user could have an emoji with no term, or vice versa). Every surface that
 * decides whether to render/reserve space for a status uses this.
 */
export function hasStatus(emoji: string | null | undefined, text: string | null | undefined): boolean {
  return Boolean(emoji || text)
}

/** Does this emoji+text pair match one of the known presets exactly? Used to highlight the selected preset row in `StatusEditor`. */
export function matchingPreset(
  emoji: string | null | undefined,
  text: string | null | undefined,
): StatusPreset | undefined {
  return STATUS_PRESETS.find((p) => p.emoji === emoji && p.text === text)
}
