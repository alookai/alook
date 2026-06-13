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
