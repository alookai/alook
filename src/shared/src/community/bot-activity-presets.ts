/**
 * Server-side translation from a bot's derived `AgentActivityState` to an
 * emoji+text pair the client renders as an ordinary status pill — the SAME
 * `community_user_profile.status_emoji`/`status_text` fields a human sets via
 * `StatusEditor`, so bots and humans share one status pipeline end-to-end and
 * the client never needs a "is this a bot" branch.
 *
 * `pickBotActivityPreset` is called by `ws-do` when it receives an
 * `agent_activity` frame from a daemon and writes the translated pair back to
 * D1. `running` has a pool of fun variants; the pool index is chosen ONCE per
 * episode on the server, then persisted like any other status, so every
 * viewer (owner or not, first load or WS delta, before or after a reconnect)
 * sees the same phrase for that episode.
 */
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

/**
 * Every emoji+text pair the WS DO writes when translating an
 * `AgentActivityState`. Lets a consumer tell "system-driven bot-activity pill
 * this pipeline wrote" from "human/owner-set custom status" without a
 * `system_driven` column. Single source of truth so the reconciler's stuck-idle
 * check and the write path's overwrite guard can never drift from the presets
 * actually emitted.
 */
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

/**
 * Deterministic across process restarts and reconnects if the caller passes
 * the same `seed`; random per-episode if it doesn't. `ws-do` passes
 * `Math.random()` on each fresh state → `running` transition and stores the
 * chosen pair in D1 — so subsequent reads (fresh page load, WS push, other
 * viewers) all see the same phrase without needing to re-derive it.
 */
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
