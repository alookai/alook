/**
 * Per-user rate limit for community message-send routes, backed by the
 * existing `RATE_LIMIT_KV` namespace (already used by better-auth in
 * `lib/auth.ts` — separate key prefix so the two never collide).
 *
 * Fixed-window counter: at most `MAX_MESSAGES_PER_WINDOW` sends per user per
 * `WINDOW_MS`. Keyed by userId only (not per-channel/DM) — the goal is to
 * stop a single attacker from flooding any channel, regardless of how many
 * targets they spread requests across. `expirationTtl` self-cleans the KV
 * entry, so there's no sweep/cron needed.
 *
 * Limits start deliberately generous — the goal is killing scripted
 * flooding, not throttling normal chat bursts. Tune down if abuse is
 * observed in practice.
 */

const WINDOW_MS = 10_000
const MAX_MESSAGES_PER_WINDOW = 30

type RateLimitState = { count: number; windowStart: number }

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number }

export async function checkMessageRateLimit(
  kv: KVNamespace,
  userId: string,
): Promise<RateLimitResult> {
  const key = `community:msgrate:${userId}`
  const now = Date.now()
  const raw = await kv.get(key)
  const state: RateLimitState | null = raw ? JSON.parse(raw) : null

  if (!state || now - state.windowStart >= WINDOW_MS) {
    await kv.put(
      key,
      JSON.stringify({ count: 1, windowStart: now } satisfies RateLimitState),
      { expirationTtl: Math.ceil(WINDOW_MS / 1000) },
    )
    return { allowed: true }
  }

  if (state.count >= MAX_MESSAGES_PER_WINDOW) {
    const retryAfterSec = Math.ceil((state.windowStart + WINDOW_MS - now) / 1000)
    return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) }
  }

  await kv.put(
    key,
    JSON.stringify({ count: state.count + 1, windowStart: state.windowStart } satisfies RateLimitState),
    { expirationTtl: Math.ceil(WINDOW_MS / 1000) },
  )
  return { allowed: true }
}
