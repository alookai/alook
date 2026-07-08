/**
 * ⚠️ READ BEFORE ADDING NEW HELPERS TO THIS MODULE ⚠️
 *
 * This module is backed by **Cloudflare Workers KV**, which is explicitly
 * **eventually consistent** — not "usually consistent," not "consistent
 * within one PoP." Cloudflare's own docs are blunt about this:
 *
 *   "Changes are usually immediately visible at the location where they
 *    are made. However, this is not guaranteed."
 *      — https://developers.cloudflare.com/kv/concepts/how-kv-works/
 *
 * Concretely, KV does not give you:
 *   - Atomic read-modify-write / compare-and-swap
 *   - Transactions
 *   - Any ordering guarantee across writes to the same key
 *   - Read-your-writes, even from the same isolate
 *
 * A `get → mutate → put` on the same key from two concurrent Workers can
 * — and will, under load — both read the same value and both write, with
 * one update silently lost (last-write-wins). Reads from another PoP can
 * see a stale value for up to the cache TTL (~60s default).
 *
 * ✅ Use this module for:
 *   - Pure TTL memoization / read-through cache (`cached`, `cachedBatch`)
 *   - Best-effort throttles where a double-run is safe (`throttled`)
 *   - Negative-cache flags with short TTLs, config, feature flags,
 *     whitelists, static-content indexes — the classic "write rarely,
 *     read a lot" workloads KV is designed for.
 *
 * ❌ DO NOT use this module for:
 *   - Rate limiters (community message send, OTP, quota gates)
 *   - Locks / mutual exclusion
 *   - Counters / tallies where the exact count gates access
 *   - Unique-id allocation
 *   - Anything that reads-then-writes based on the read value
 *
 * For strongly-consistent state, use a **Durable Object**. A DO instance
 * is single-threaded and `ctx.storage` is strongly consistent — exactly
 * what the workloads above need. Canonical examples in this repo:
 *   - `src/shared/src/lib/rate-limits.ts` — every policy (windowMs, max)
 *     in one registry; every caller names a policy from here
 *   - `src/ws-do/src/rate-limit-do.ts` — the parameterized DO class
 *   - `src/web/src/lib/rate-limit.ts` — `checkRateLimit(env, name, key)`,
 *     the single entry point used by both community message send and
 *     auth OTP send
 *
 * If in doubt: does the correctness of your feature depend on the count
 * being exact, the value being current, or the write being visible on
 * the next read? If yes → DO. If no (a stale value / double-run / lost
 * update is genuinely harmless) → KV via this module is fine.
 */

const log = {
  warn(msg: string, ctx: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "warn", service: "cache", msg, ...ctx, ts: new Date().toISOString() }));
  },
};

let _kv: KVNamespace | null | undefined;

export function bindCacheKV(kv: KVNamespace | null) {
  _kv = kv;
}

export function getKV(): KVNamespace | null {
  return _kv ?? null;
}

const MIN_KV_TTL = 60;

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const kv = getKV();
  if (kv) {
    try {
      const raw = await kv.get(key);
      if (raw) return JSON.parse(raw) as T;
    } catch (err) {
      log.warn("KV read failed", { key, err });
    }
  }

  const value = await fn();

  if (value != null && kv) {
    kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(ttlSeconds, MIN_KV_TTL) }).catch((err) => {
      log.warn("KV write failed", { key, err });
    });
  }

  return value;
}

/**
 * Batch-get from KV. Returns { hits, misses } where hits is a Map of found entries
 * and misses is the list of keys that need to be fetched from D1.
 * On KV failure, all keys are returned as misses (graceful fallback).
 */
export async function cachedBatch<T>(
  keys: string[],
  ttlSeconds: number,
  fetchMissing: (missingKeys: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  if (keys.length === 0) return new Map();

  const kv = getKV();
  const result = new Map<string, T>();
  let missingKeys = keys;

  if (kv) {
    const hits: string[] = [];
    await Promise.all(
      keys.map(async (key) => {
        try {
          const raw = await kv.get(key);
          if (raw) {
            result.set(key, JSON.parse(raw) as T);
            hits.push(key);
          }
        } catch (err) {
          log.warn("KV batch read failed", { key, err });
        }
      }),
    );
    missingKeys = keys.filter((k) => !hits.includes(k));
  }

  if (missingKeys.length > 0) {
    const fetched = await fetchMissing(missingKeys);
    for (const [key, value] of fetched) {
      result.set(key, value);
      if (value != null && kv) {
        kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(ttlSeconds, MIN_KV_TTL) }).catch((err) => {
          log.warn("KV batch write failed", { key, err });
        });
      }
    }
  }

  return result;
}

/**
 * Timestamp-based throttle — not limited by KV's 60s minimum TTL.
 * Stores last-run timestamp in KV; skips `fn` if within `intervalSeconds`.
 * Returns true if `fn` ran, false if throttled.
 *
 * ⚠️ CF KV is NOT strongly consistent. This is a read-then-write against
 * eventual-consistency storage — two concurrent Workers can both read
 * "not set" and both run `fn`. That's acceptable ONLY because every caller
 * of `throttled(...)` in this codebase can tolerate the occasional
 * double-run (sweep jobs, negative-cache flags, last-used bumps —
 * self-healing on the next call).
 *
 * For a counter that MUST NOT overshoot (rate limit, quota), use a
 * Durable Object — see `src/ws-do/src/rate-limit-do.ts`.
 */
export async function throttled(
  key: string,
  intervalSeconds: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const kv = getKV();
  if (kv) {
    try {
      const raw = await kv.get(key);
      if (raw) {
        const elapsed = Date.now() - parseInt(raw, 10);
        if (elapsed < intervalSeconds * 1000) return false;
      }
    } catch {}
  }

  await fn();

  if (kv) {
    kv.put(key, String(Date.now()), {
      expirationTtl: Math.max(intervalSeconds * 10, MIN_KV_TTL),
    }).catch(() => {});
  }

  return true;
}

export async function invalidate(key: string): Promise<void> {
  const kv = getKV();
  if (kv) await kv.delete(key).catch((err) => {
    log.warn("KV invalidate failed", { key, err });
  });
}

export async function invalidateMany(keys: string[]): Promise<void> {
  const kv = getKV();
  if (!kv || keys.length === 0) return;
  await Promise.all(keys.map((key) => kv.delete(key).catch((err) => {
    log.warn("KV invalidate failed", { key, err });
  })));
}

const INBOX_TYPE_COMBOS = [
  "*",
  "user_dm_message",
  "calendar_event",
  "email_notification",
  "calendar_event,email_notification",
  "calendar_event,user_dm_message",
  "email_notification,user_dm_message",
  "calendar_event,email_notification,user_dm_message",
];

export function invalidateInboxCounts(userId: string, workspaceId: string): Promise<void> {
  const prefix = `inbox:${userId}:${workspaceId}:`;
  return invalidateMany(INBOX_TYPE_COMBOS.map((combo) => `${prefix}${combo}`));
}

export const cacheKeys = {
  machineToken: (token: string) => `mt:${token.slice(0, 20)}`,
  machineTokenLastUsed: (token: string) => `mt_lu:${token.slice(0, 20)}`,
  member: (workspaceId: string, userId: string) => `mem:${workspaceId}:${userId}`,
  runtimeIds: (workspaceId: string, daemonId: string) => `rt:${workspaceId}:${daemonId}`,
  agent: (workspaceId: string, agentId: string) => `ag:${workspaceId}:${agentId}`,
  heartbeat: (workspaceId: string, daemonId: string) => `hb:${workspaceId}:${daemonId}`,
  user: (userId: string) => `usr:${userId}`,
  allEmailAccounts: (workspaceId: string) => `ea:${workspaceId}`,
  agentLinks: (workspaceId: string) => `al:${workspaceId}`,
  allHandles: (workspaceId: string) => `handles:${workspaceId}`,
  overviewEmailAccounts: (workspaceId: string) => `ov_ea:${workspaceId}`,
  overviewEmailStats: (workspaceId: string) => `ov_email:${workspaceId}`,
  overviewTaskStats: (workspaceId: string, dateStr: string) => `ov_task:${workspaceId}:${dateStr}`,
  allAgentAccess: (workspaceId: string) => `aa:${workspaceId}`,
  allRuntimes: (workspaceId: string) => `runtimes:${workspaceId}`,
  allMembers: (workspaceId: string) => `members:${workspaceId}`,
  activeTaskCounts: (workspaceId: string) => `atc:${workspaceId}`,
  inboxCount: (userId: string, workspaceId: string, types?: string[]) =>
    `inbox:${userId}:${workspaceId}:${types ? [...types].sort().join(",") : "*"}`,
  hasPendingFileRequest: (workspaceId: string) => `fr_p:${workspaceId}`,
  pins: (workspaceId: string, userId: string) => `pins:${workspaceId}:${userId}`,
};
