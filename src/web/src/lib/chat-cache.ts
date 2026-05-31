import { openDB, type IDBPDatabase } from "idb";
import type { Message } from "@alook/shared";

export interface CacheMeta {
  conversation_id: string;
  lastFetchedAt: number;
  lastAccessedAt: number;
  messageCount: number;
  newestMessageId: string | null;
  hasMore: boolean;
  serverMessageCount: number;
}

/**
 * Pointer to the **latest-created** conversation for a given agent+channel, used
 * to render the multi-conversation chat page cache-first (without a gating
 * network round-trip to resolve "which conversation is this?").
 *
 * Semantics: this is the latest-created conversation as last known to THIS
 * client — matching the server's `check-fresh` definition of "current"
 * (`getOrCreateAgentConversation` → `orderBy(desc(createdAt))`). It is NOT "the
 * conversation the user last manually opened". Honoring those two as the same
 * concept caused the wrong-conversation flash: an explicit `?conv=<old-id>` open
 * would record an old conversation, then the param-less open painted it and
 * visibly swapped to the server's latest. Only writes that establish
 * "latest-created" (slow-path server-resolved load, chatInit fallback, and the
 * `task.created` WS refresh) may update this pointer.
 *
 * Cross-device caveat: if another device/tab just created a newer conversation
 * this client hasn't heard of yet, the pointer may briefly lag until the next
 * `check-fresh` corrects it — the rare residual case, no longer the common one.
 *
 * The DB is already scoped per-workspace (`alook-chat-cache-${workspaceId}`),
 * so the key only needs to encode agent + channel.
 */
export interface LastOpenEntry {
  /** `${agentId}::${channel == null ? "" : channel}` — see {@link lastOpenKey} */
  key: string;
  conversation_id: string;
  newestMessageId: string | null;
  serverMessageCount: number;
  updatedAt: number;
}

interface ChatCacheDB {
  messages: {
    key: [string, string];
    value: Message;
    indexes: {
      "by-conversation": string;
      "by-created": [string, string];
    };
  };
  cache_meta: {
    key: string;
    value: CacheMeta;
  };
  last_open: {
    key: string;
    value: LastOpenEntry;
    indexes: {
      "by-conversation": string;
    };
  };
}

const DB_VERSION = 3;
const MAX_CONVERSATIONS = 50;

let dbPromise: Promise<IDBPDatabase<ChatCacheDB>> | null = null;
let currentWorkspaceId: string | null = null;

export function openCacheDB(workspaceId: string): Promise<IDBPDatabase<ChatCacheDB>> | null {
  if (typeof indexedDB === "undefined") return null;

  if (dbPromise && currentWorkspaceId === workspaceId) return dbPromise;

  currentWorkspaceId = workspaceId;
  dbPromise = openDB<ChatCacheDB>(`alook-chat-cache-${workspaceId}`, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const msgStore = db.createObjectStore("messages", {
          keyPath: ["conversation_id", "id"],
        });
        msgStore.createIndex("by-conversation", "conversation_id", { unique: false });
        msgStore.createIndex("by-created", ["conversation_id", "created_at"], { unique: false });

        db.createObjectStore("cache_meta", { keyPath: "conversation_id" });
      }
      // v1 → v2: serverMessageCount field added to cache_meta entries.
      // No schema migration needed — the field is added at write time with default 0.
      if (oldVersion < 3) {
        // v2 → v3: last-open conversation pointer per agent+channel. Existing
        // `messages`/`cache_meta` stores are untouched; this store starts empty,
        // so the first param-less open is a clean cache miss (today's behavior),
        // then it populates.
        const lastOpenStore = db.createObjectStore("last_open", { keyPath: "key" });
        lastOpenStore.createIndex("by-conversation", "conversation_id", { unique: false });
      }
    },
  });

  return dbPromise;
}

function getDB(workspaceId?: string): Promise<IDBPDatabase<ChatCacheDB>> | null {
  if (workspaceId) return openCacheDB(workspaceId);
  return dbPromise;
}

export async function getCachedMessages(conversationId: string, workspaceId?: string): Promise<Message[] | null> {
  const p = getDB(workspaceId);
  if (!p) return null;

  try {
    const db = await p;
    const messages = await db.getAllFromIndex("messages", "by-conversation", conversationId);
    if (messages.length === 0) return null;

    const filtered = messages.filter(
      (m) => m.status !== "buffered" && !m.id.startsWith("temp-")
    );

    filtered.sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at);
      if (cmp !== 0) return cmp;
      return a.id.localeCompare(b.id);
    });

    // Update lastAccessedAt
    const meta = await db.get("cache_meta", conversationId);
    if (meta) {
      await db.put("cache_meta", { ...meta, lastAccessedAt: Date.now() });
    }

    return filtered;
  } catch {
    return null;
  }
}

export async function getCachedMessagesBefore(
  conversationId: string,
  beforeCreatedAt: string,
  beforeId: string,
  limit: number,
  workspaceId?: string
): Promise<{ messages: Message[]; hasMore: boolean } | null> {
  const p = getDB(workspaceId);
  if (!p) return null;

  try {
    const db = await p;
    const meta = await db.get("cache_meta", conversationId);
    if (!meta) return null;

    const range = IDBKeyRange.bound(
      [conversationId, ""],
      [conversationId, beforeCreatedAt],
      false,
      false
    );

    const allInRange = await db.getAllFromIndex("messages", "by-created", range);

    const filtered = allInRange.filter((m) => {
      if (m.status === "buffered" || m.id.startsWith("temp-")) return false;
      if (m.created_at === beforeCreatedAt && m.id >= beforeId) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const cmp = b.created_at.localeCompare(a.created_at);
      if (cmp !== 0) return cmp;
      return b.id.localeCompare(a.id);
    });

    const topN = filtered.slice(0, limit);

    if (topN.length < limit && meta.hasMore) return null;

    await db.put("cache_meta", { ...meta, lastAccessedAt: Date.now() });

    const result = topN.reverse();
    return {
      messages: result,
      hasMore: filtered.length > limit || meta.hasMore,
    };
  } catch {
    return null;
  }
}

export async function mergeCachedMessages(
  conversationId: string,
  messages: Message[],
  hasMore: boolean | null,
  workspaceId?: string,
  serverMessageCount?: number
): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  try {
    const db = await p;

    const validMessages = messages.filter(
      (m) => m.status !== "buffered" && !m.id.startsWith("temp-")
    );
    if (validMessages.length === 0) return;

    const tx = db.transaction(["messages", "cache_meta"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const metaStore = tx.objectStore("cache_meta");

    for (const msg of validMessages) {
      await msgStore.put(msg);
    }

    const allKeys = await msgStore.index("by-conversation").getAllKeys(conversationId);

    const now = Date.now();
    const newestInBatch = validMessages.reduce((a, b) =>
      a.created_at > b.created_at ? a : b
    );

    const existingMeta = await metaStore.get(conversationId);
    const resolvedHasMore = hasMore ?? existingMeta?.hasMore ?? true;

    const newestMessageId =
      existingMeta?.newestMessageId && existingMeta.newestMessageId !== newestInBatch.id
        ? await (async () => {
            const existing = await msgStore.get([conversationId, existingMeta.newestMessageId!]);
            if (existing && existing.created_at > newestInBatch.created_at) return existing.id;
            return newestInBatch.id;
          })()
        : newestInBatch.id;

    const meta: CacheMeta = {
      conversation_id: conversationId,
      lastFetchedAt: now,
      lastAccessedAt: now,
      messageCount: allKeys.length,
      newestMessageId,
      hasMore: resolvedHasMore,
      serverMessageCount: serverMessageCount ?? existingMeta?.serverMessageCount ?? 0,
    };
    await metaStore.put(meta);

    await tx.done;

    evictLRU().catch(() => {});
  } catch {
    // Graceful degradation
  }
}

export async function appendCachedMessage(
  conversationId: string,
  message: Message,
  workspaceId?: string
): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  if (message.status === "buffered" || message.id.startsWith("temp-")) return;

  try {
    const db = await p;
    const meta = await db.get("cache_meta", conversationId);
    if (!meta) return;

    const existing = await db.get("messages", [conversationId, message.id]);
    await db.put("messages", message);

    await db.put("cache_meta", {
      ...meta,
      lastAccessedAt: Date.now(),
      messageCount: existing ? meta.messageCount : meta.messageCount + 1,
      newestMessageId: message.id,
    });
  } catch {
    // Graceful degradation
  }
}

export async function removeCachedMessage(
  conversationId: string,
  messageId: string,
  workspaceId?: string
): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  try {
    const db = await p;
    await db.delete("messages", [conversationId, messageId]);

    const meta = await db.get("cache_meta", conversationId);
    if (meta) {
      await db.put("cache_meta", {
        ...meta,
        messageCount: Math.max(0, meta.messageCount - 1),
      });
    }
  } catch {
    // Graceful degradation
  }
}

export async function getCacheMeta(conversationId: string, workspaceId?: string): Promise<CacheMeta | null> {
  const p = getDB(workspaceId);
  if (!p) return null;

  try {
    const db = await p;
    return (await db.get("cache_meta", conversationId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the `last_open` key. `null` and `undefined` channel both normalize to
 * `""`, so the param-less "default channel" maps to one stable entry.
 */
function lastOpenKey(agentId: string, channel: string | null | undefined): string {
  return `${agentId}::${channel == null ? "" : channel}`;
}

/**
 * Read the last-open conversation pointer for an agent+channel. IndexedDB only,
 * no network. Returns null on cache miss, error, or SSR (no indexedDB).
 *
 * Note: `null` and `undefined` channel resolve to the same entry (see
 * {@link lastOpenKey}).
 */
export async function getLastOpenConversation(
  agentId: string,
  channel: string | null | undefined,
  workspaceId?: string
): Promise<LastOpenEntry | null> {
  const p = getDB(workspaceId);
  if (!p) return null;

  try {
    const db = await p;
    return (await db.get("last_open", lastOpenKey(agentId, channel))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Write the per-channel pointer to the **latest-created** conversation for an
 * agent+channel (see {@link LastOpenEntry}). Call ONLY when establishing
 * latest-created semantics — i.e. from a server-resolved (slow-path) load, the
 * chatInit fallback, or the `task.created` WS refresh. Do NOT call it for an
 * explicit `?conv=<id>` (fast-path) open: that records "last opened", not
 * "latest", and reintroduces the wrong-conversation flash.
 *
 * Values should be server-confirmed where available so the next open's freshness
 * compare is accurate. The `task.created` path derives `serverMessageCount` from
 * the locally-cached count (may under-count → at worst the next read falls back
 * to the skeleton via the `serverMessageCount > 0` gate, never wrong content).
 */
export async function setLastOpenConversation(
  agentId: string,
  channel: string | null | undefined,
  entry: Pick<LastOpenEntry, "conversation_id" | "newestMessageId" | "serverMessageCount">,
  workspaceId?: string
): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  try {
    const db = await p;
    await db.put("last_open", {
      key: lastOpenKey(agentId, channel),
      conversation_id: entry.conversation_id,
      newestMessageId: entry.newestMessageId,
      serverMessageCount: entry.serverMessageCount,
      updatedAt: Date.now(),
    });
  } catch {
    // Graceful degradation
  }
}

/**
 * Remove any `last_open` pointer(s) referencing the given conversation. Used
 * when invalidating a conversation so we don't render then immediately wipe.
 */
export async function clearLastOpenForConversation(
  conversationId: string,
  workspaceId?: string
): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  try {
    const db = await p;
    const tx = db.transaction("last_open", "readwrite");
    const store = tx.objectStore("last_open");
    const keys = await store.index("by-conversation").getAllKeys(conversationId);
    for (const key of keys) {
      await store.delete(key);
    }
    await tx.done;
  } catch {
    // Graceful degradation
  }
}

export async function invalidateCache(conversationId: string, workspaceId?: string): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  try {
    const db = await p;
    const tx = db.transaction(["messages", "cache_meta", "last_open"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const metaStore = tx.objectStore("cache_meta");
    const lastOpenStore = tx.objectStore("last_open");

    const keys = await msgStore.index("by-conversation").getAllKeys(conversationId);
    for (const key of keys) {
      await msgStore.delete(key);
    }
    await metaStore.delete(conversationId);

    // Drop any last-open pointer to this conversation so a later param-less
    // open doesn't briefly render the invalidated conversation.
    const lastOpenKeys = await lastOpenStore.index("by-conversation").getAllKeys(conversationId);
    for (const key of lastOpenKeys) {
      await lastOpenStore.delete(key);
    }

    await tx.done;
  } catch {
    // Graceful degradation
  }
}

export async function evictLRU(maxConversations = MAX_CONVERSATIONS): Promise<void> {
  const p = getDB();
  if (!p) return;

  try {
    const db = await p;
    const allMeta = await db.getAll("cache_meta");
    if (allMeta.length <= maxConversations) return;

    allMeta.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const toEvict = allMeta.slice(0, allMeta.length - maxConversations);

    const tx = db.transaction(["messages", "cache_meta", "last_open"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const metaStore = tx.objectStore("cache_meta");
    const lastOpenStore = tx.objectStore("last_open");

    for (const meta of toEvict) {
      const keys = await msgStore.index("by-conversation").getAllKeys(meta.conversation_id);
      for (const key of keys) {
        await msgStore.delete(key);
      }
      await metaStore.delete(meta.conversation_id);

      // Prune any last-open pointers to the evicted conversation so we never
      // keep a dangling id that would resolve to an empty cache.
      const lastOpenKeys = await lastOpenStore.index("by-conversation").getAllKeys(meta.conversation_id);
      for (const key of lastOpenKeys) {
        await lastOpenStore.delete(key);
      }
    }

    await tx.done;
  } catch {
    // Graceful degradation
  }
}

export async function clearAllCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  try {
    if (dbPromise) {
      const db = await dbPromise;
      db.close();
      dbPromise = null;
    }
    if (currentWorkspaceId) {
      await deleteDB(`alook-chat-cache-${currentWorkspaceId}`);
      currentWorkspaceId = null;
    }
  } catch {
    // Graceful degradation
  }
}

async function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
