import {
  BOT_ACTIVITY_PRESETS,
  RUNNING_PRESETS,
} from "@alook/shared"

type StatusPair = { emoji: string; text: string }

function matchesStatus(
  emoji: string | null | undefined,
  text: string | null | undefined,
  pair: StatusPair,
): boolean {
  return emoji === pair.emoji && text === pair.text
}

export function isBotActivityActive(
  emoji: string | null | undefined,
  text: string | null | undefined,
): boolean {
  return matchesStatus(emoji, text, BOT_ACTIVITY_PRESETS.starting)
    || matchesStatus(emoji, text, BOT_ACTIVITY_PRESETS.stopping)
    || isBotActivityRunning(emoji, text)
}

export function isBotActivityRunning(
  emoji: string | null | undefined,
  text: string | null | undefined,
): boolean {
  return RUNNING_PRESETS.some((pair) => matchesStatus(emoji, text, pair))
}
