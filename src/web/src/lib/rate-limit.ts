import { wsDoFetch } from "@/lib/broadcast"
import { RATE_LIMITS, type RateLimitName, type RateLimitPolicy, type RateLimitResult } from "@alook/shared"

// Re-export the shared types from this module so route handlers only need
// one import path (`@/lib/rate-limit`) instead of two.
export type { RateLimitName, RateLimitPolicy, RateLimitResult }

/**
 * Unified rate-limit entry point for every rate-limit-sensitive path in
 * this app. Adds a new rate limit? Register it in
 * `src/shared/src/lib/rate-limits.ts` first, then call this helper.
 *
 * Backed by `RateLimitDurableObject` in the `alook-ws-do` worker via the
 * `WS_DO_WORKER` service binding. The DO's `ctx.storage` is strongly
 * consistent, so concurrent callers can't leak past the cap the way a
 * KV-backed counter could.
 *
 * Sharding: one DO instance per (name, key) pair — different rate-limit
 * names never collide even with a shared key.
 *
 * Fail-open: transport errors return `{ allowed: true }`. The DO is a
 * strong-consistency counter, not a security perimeter; auth/authz above
 * the rate limit is what actually gates access. Locking every user out
 * because we can't reach the DO would be a worse failure mode.
 *
 * @param env    Worker env (used to reach `WS_DO_WORKER`).
 * @param name   Registered policy name — must exist in `RATE_LIMITS`.
 * @param key    Caller-chosen shard key. Typically userId, but any stable
 *               string works (email, IP, `${userId}:${channelId}`, …).
 * @param overrides  Optional per-call override of `windowMs` / `max`. Use
 *                   sparingly — the registry is meant to be the source of
 *                   truth. Currently used only for auth OTP where the
 *                   window is env-configurable.
 */
export async function checkRateLimit(
  env: Env,
  name: RateLimitName,
  key: string,
  overrides?: Partial<RateLimitPolicy>,
): Promise<RateLimitResult> {
  const policy = RATE_LIMITS[name]
  const windowMs = overrides?.windowMs ?? policy.windowMs
  const max = overrides?.max ?? policy.max
  try {
    const res = await wsDoFetch(
      env,
      "/rate-limit/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, key, windowMs, max }),
      },
      { label: `${name}:${key}`, type: "rate-limit" },
    )
    if (!res.ok) return { allowed: true }
    return (await res.json()) as RateLimitResult
  } catch {
    return { allowed: true }
  }
}
