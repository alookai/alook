
import type { AgentActivityState } from "../community-cli-contract";

export type BotActivityPreset = { emoji: string; text: string };

export const BOT_ACTIVITY_PRESETS: Record<
  Exclude<AgentActivityState, "running">,
  BotActivityPreset
> = {
  idle: { emoji: "💤", text: "Idle" },
  starting: { emoji: "🌀", text: "Waking up" },
  stopping: { emoji: "🌙", text: "Wrapping up" },
};

export const RUNNING_PRESETS: BotActivityPreset[] = [
  { emoji: "⚡", text: "Working on it" },
  { emoji: "🛠️", text: "Cooking" },
  { emoji: "🧠", text: "Thinking hard" },
  { emoji: "🔧", text: "Tinkering" },
  { emoji: "🚀", text: "On it" },
  { emoji: "🔥", text: "In the zone" },
];

export const BOT_ACTIVITY_STATUS_PAIRS: ReadonlyArray<BotActivityPreset> = [
  BOT_ACTIVITY_PRESETS.idle,
  BOT_ACTIVITY_PRESETS.starting,
  BOT_ACTIVITY_PRESETS.stopping,
  ...RUNNING_PRESETS,
];

/**
 * True iff (emoji, text) is a known bot-activity preset — i.e. the activity
 * pipeline owns this pill and may overwrite it. A null pair (no status set) and
 * any owner-set custom status return false, so both are left untouched.
 */
export function isBotActivityStatus(emoji: string | null, text: string | null): boolean {
  if (emoji === null && text === null) return false;
  return BOT_ACTIVITY_STATUS_PAIRS.some((p) => p.emoji === emoji && p.text === text);
}

export function pickBotActivityPreset(
  state: AgentActivityState,
  seed: number
): BotActivityPreset {
  if (state === "running") {
    const i = Math.floor(seed * RUNNING_PRESETS.length) % RUNNING_PRESETS.length;
    return RUNNING_PRESETS[i]!;
  }
  return BOT_ACTIVITY_PRESETS[state];
}
