/**
 * Central registry of every rate limit in the system.
 *
 * Every rate-limit call site MUST name a policy that appears in this
 * table. Adding a new limit? Add its entry here first, then reference it
 * from the caller — this keeps every ceiling visible in one place and
 * prevents ad-hoc per-caller magic numbers from proliferating.
 *
 * Naming: `<namespace>:<action>`. Keep the namespace scoped to the
 * subsystem that owns the action, not to the transport that enforces it
 * (they're all backed by the same DO — the transport is an implementation
 * detail).
 *
 * Runtime enforcement lives in `RateLimitDurableObject` (see
 * `src/ws-do/src/rate-limit-do.ts`). Callers reach it via the web-side
 * helper at `src/web/src/lib/rate-limit.ts` (`checkRateLimit`), which
 * fails open on transport error — the DO is a strong-consistency
 * counter, not a security perimeter.
 */
export const RATE_LIMITS = {
  /**
   * Community message send (channel + DM). Prevents scripted flooding of
   * any single channel/DM without throttling normal chat bursts.
   */
  "community:msgSend": { windowMs: 10_000, max: 30 },
  /**
   * OTP send (better-auth `/email-otp/send-verification-otp`). Prevents
   * cost/abuse from someone spamming another user's inbox. Window/max are
   * overridable via `AUTH_OTP_RATE_LIMIT_MAX` / `_WINDOW_SEC`.
   */
  "auth:otpSend": { windowMs: 60_000, max: 5 },
} as const

export type RateLimitName = keyof typeof RATE_LIMITS

export type RateLimitPolicy = {
  windowMs: number
  max: number
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number }
