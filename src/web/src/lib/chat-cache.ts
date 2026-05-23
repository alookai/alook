import { openDB, type IDBPDatabase } from "idb";
import type { Message } from "@alook/shared";

export interface CacheMeta {
  conversation_id: string;
  lastFetchedAt: number;
  lastAccessedAt: number;
  messageCount: number;
  newestMessageId: string | null;
  hasMore: boolean;
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
}

const DB_VERSION = 1;
const MAX_CONVERSATIONS = 50;

let dbPromise: Promise<IDBPDatabase<ChatCacheDB>> | null = null;
let currentWorkspaceId: string | null = null;

export function openCacheDB(workspaceId: string): Promise<IDBPDatabase<ChatCacheDB>> | null {
  if (typeof indexedDB === "undefined") return null;

  if (dbPromise && currentWorkspaceId === workspaceId) return dbPromise;

  currentWorkspaceId = workspaceId;
  dbPromise = openDB<ChatCacheDB>(`alook-chat-cache-${workspaceId}`, DB_VERSION, {
    upgrade(db) {
      const msgStore = db.createObjectStore("messages", {
        keyPath: ["conversation_id", "id"],
      });
      msgStore.createIndex("by-conversation", "conversation_id", { unique: false });
      msgStore.createIndex("by-created", ["conversation_id", "created_at"], { unique: false });

      db.createObjectStore("cache_meta", { keyPath: "conversation_id" });
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
  workspaceId?: string
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

export async function invalidateCache(conversationId: string, workspaceId?: string): Promise<void> {
  const p = getDB(workspaceId);
  if (!p) return;

  try {
    const db = await p;
    const tx = db.transaction(["messages", "cache_meta"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const metaStore = tx.objectStore("cache_meta");

    const keys = await msgStore.index("by-conversation").getAllKeys(conversationId);
    for (const key of keys) {
      await msgStore.delete(key);
    }
    await metaStore.delete(conversationId);

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

    const tx = db.transaction(["messages", "cache_meta"], "readwrite");
    const msgStore = tx.objectStore("messages");
    const metaStore = tx.objectStore("cache_meta");

    for (const meta of toEvict) {
      const keys = await msgStore.index("by-conversation").getAllKeys(meta.conversation_id);
      for (const key of keys) {
        await msgStore.delete(key);
      }
      await metaStore.delete(meta.conversation_id);
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
