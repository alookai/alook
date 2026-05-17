let _kv: KVNamespace | null | undefined;

export function bindCacheKV(kv: KVNamespace | null) {
  _kv = kv;
}

export function getKV(): KVNamespace | null {
  return _kv ?? null;
}

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
      console.warn(`[cache] KV read failed for ${key}:`, err);
    }
  }

  const value = await fn();

  if (value != null && kv) {
    kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }).catch((err) => {
      console.warn(`[cache] KV write failed for ${key}:`, err);
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
          console.warn(`[cache] KV batch read failed for ${key}:`, err);
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
        kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }).catch((err) => {
          console.warn(`[cache] KV batch write failed for ${key}:`, err);
        });
      }
    }
  }

  return result;
}

export async function invalidate(key: string): Promise<void> {
  const kv = getKV();
  if (kv) await kv.delete(key).catch((err) => {
    console.warn(`[cache] KV delete failed for ${key}:`, err);
  });
}

export async function invalidateMany(keys: string[]): Promise<void> {
  const kv = getKV();
  if (!kv || keys.length === 0) return;
  await Promise.all(keys.map((key) => kv.delete(key).catch((err) => {
    console.warn(`[cache] KV delete failed for ${key}:`, err);
  })));
}

export const cacheKeys = {
  machineToken: (token: string) => `mt:${token.slice(0, 20)}`,
  machineTokenLastUsed: (token: string) => `mt_lu:${token.slice(0, 20)}`,
  member: (workspaceId: string, userId: string) => `mem:${workspaceId}:${userId}`,
  runtimeIds: (workspaceId: string, daemonId: string) => `rt:${workspaceId}:${daemonId}`,
  agent: (workspaceId: string, agentId: string) => `ag:${workspaceId}:${agentId}`,
  heartbeat: (workspaceId: string, daemonId: string) => `hb:${workspaceId}:${daemonId}`,
  user: (userId: string) => `usr:${userId}`,
  emailAccountsByAgent: (workspaceId: string, agentId: string) => `ea:${workspaceId}:${agentId}`,
  colleaguesByAgent: (workspaceId: string, agentId: string) => `col:${workspaceId}:${agentId}`,
};
