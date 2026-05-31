import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import type { Message } from "@alook/shared";
import {
  openCacheDB,
  getCachedMessages,
  getCachedMessagesBefore,
  mergeCachedMessages,
  appendCachedMessage,
  removeCachedMessage,
  getCacheMeta,
  invalidateCache,
  evictLRU,
  clearAllCache,
  getLastOpenConversation,
  setLastOpenConversation,
  clearLastOpenForConversation,
} from "./chat-cache";

const WORKSPACE_ID = "ws_test";

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    conversation_id: "conv_1",
    role: "user",
    content: "hello",
    task_id: null,
    attachment_ids: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAllCache();
  openCacheDB(WORKSPACE_ID);
});

describe("chat-cache", () => {
  describe("openCacheDB", () => {
    it("creates DB with correct schema", async () => {
      const p = openCacheDB(WORKSPACE_ID);
      expect(p).not.toBeNull();
      const db = await p!;
      expect(db.objectStoreNames.contains("messages")).toBe(true);
      expect(db.objectStoreNames.contains("cache_meta")).toBe(true);
      expect(db.objectStoreNames.contains("last_open")).toBe(true);
    });
  });

  describe("mergeCachedMessages", () => {
    it("writes messages and updates meta", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
      ];

      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(2);
      expect(cached![0].id).toBe("m1");
      expect(cached![1].id).toBe("m2");

      const meta = await getCacheMeta("conv_1", WORKSPACE_ID);
      expect(meta).not.toBeNull();
      expect(meta!.messageCount).toBeGreaterThanOrEqual(2);
      expect(meta!.hasMore).toBe(false);
    });

    it("merges without overwriting older messages", async () => {
      const older = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
      ];
      await mergeCachedMessages("conv_1", older, true, WORKSPACE_ID);

      const newer = [
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", newer, false, WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(3);
      expect(cached!.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });

    it("does not regress newestMessageId when merging older messages", async () => {
      const newer = [
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
        makeMessage({ id: "m4", conversation_id: "conv_1", created_at: "2024-01-01T00:03:00Z" }),
      ];
      await mergeCachedMessages("conv_1", newer, true, WORKSPACE_ID);

      const metaBefore = await getCacheMeta("conv_1", WORKSPACE_ID);
      expect(metaBefore!.newestMessageId).toBe("m4");

      const older = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
      ];
      await mergeCachedMessages("conv_1", older, null, WORKSPACE_ID);

      const metaAfter = await getCacheMeta("conv_1", WORKSPACE_ID);
      expect(metaAfter!.newestMessageId).toBe("m4");
      expect(metaAfter!.messageCount).toBe(4);
    });

    it("filters out buffered messages", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", status: "active" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", status: "buffered" }),
      ];

      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(1);
      expect(cached![0].id).toBe("m1");
    });

    it("filters out temp- messages", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1" }),
        makeMessage({ id: "temp-123", conversation_id: "conv_1" }),
      ];

      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(1);
      expect(cached![0].id).toBe("m1");
    });
  });

  describe("getCachedMessages", () => {
    it("returns sorted messages for a conversation", async () => {
      const msgs = [
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached![0].id).toBe("m1");
      expect(cached![1].id).toBe("m2");
    });

    it("returns null for unknown conversation", async () => {
      const cached = await getCachedMessages("nonexistent", WORKSPACE_ID);
      expect(cached).toBeNull();
    });

    it("excludes buffered messages on read", async () => {
      const db = await openCacheDB(WORKSPACE_ID)!;
      await db.put("messages", makeMessage({ id: "m1", conversation_id: "conv_1", status: "buffered" }));
      await db.put("messages", makeMessage({ id: "m2", conversation_id: "conv_1", status: "active" }));
      await db.put("cache_meta", {
        conversation_id: "conv_1",
        lastFetchedAt: Date.now(),
        lastAccessedAt: Date.now(),
        messageCount: 2,
        newestMessageId: "m2",
        hasMore: false,
        serverMessageCount: 0,
      });

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(1);
      expect(cached![0].id).toBe("m2");
    });
  });

  describe("appendCachedMessage", () => {
    it("adds single message without overwriting existing", async () => {
      const initial = [makeMessage({ id: "m1", conversation_id: "conv_1" })];
      await mergeCachedMessages("conv_1", initial, false, WORKSPACE_ID);

      await appendCachedMessage("conv_1", makeMessage({ id: "m2", conversation_id: "conv_1" }), WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(2);
    });

    it("skips buffered messages", async () => {
      const initial = [makeMessage({ id: "m1", conversation_id: "conv_1" })];
      await mergeCachedMessages("conv_1", initial, false, WORKSPACE_ID);

      await appendCachedMessage("conv_1", makeMessage({ id: "m2", conversation_id: "conv_1", status: "buffered" }), WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(1);
    });

    it("skips temp- messages", async () => {
      const initial = [makeMessage({ id: "m1", conversation_id: "conv_1" })];
      await mergeCachedMessages("conv_1", initial, false, WORKSPACE_ID);

      await appendCachedMessage("conv_1", makeMessage({ id: "temp-abc", conversation_id: "conv_1" }), WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(1);
    });
  });

  describe("removeCachedMessage", () => {
    it("removes a single message by ID", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1" }),
        makeMessage({ id: "m2", conversation_id: "conv_1" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      await removeCachedMessage("conv_1", "m1", WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toHaveLength(1);
      expect(cached![0].id).toBe("m2");
    });
  });

  describe("invalidateCache", () => {
    it("removes all data for a conversation", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1" }),
        makeMessage({ id: "m2", conversation_id: "conv_1" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      await invalidateCache("conv_1", WORKSPACE_ID);

      const cached = await getCachedMessages("conv_1", WORKSPACE_ID);
      expect(cached).toBeNull();
      const meta = await getCacheMeta("conv_1", WORKSPACE_ID);
      expect(meta).toBeNull();
    });

    it("clears any last_open pointer referencing the invalidated conversation", async () => {
      await mergeCachedMessages("conv_1", [makeMessage({ id: "m1", conversation_id: "conv_1" })], false, WORKSPACE_ID);
      await setLastOpenConversation("agent_a", "chan", {
        conversation_id: "conv_1",
        newestMessageId: "m1",
        serverMessageCount: 1,
      }, WORKSPACE_ID);

      await invalidateCache("conv_1", WORKSPACE_ID);

      expect(await getLastOpenConversation("agent_a", "chan", WORKSPACE_ID)).toBeNull();
    });
  });

  describe("last_open pointer", () => {
    it("set then get round-trips for the same agent+channel", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_1",
        newestMessageId: "m9",
        serverMessageCount: 12,
      }, WORKSPACE_ID);

      const entry = await getLastOpenConversation("agent_a", "chan_x", WORKSPACE_ID);
      expect(entry).not.toBeNull();
      expect(entry!.conversation_id).toBe("conv_1");
      expect(entry!.newestMessageId).toBe("m9");
      expect(entry!.serverMessageCount).toBe(12);
    });

    it("is scoped by channel — a different channel returns null", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_1", newestMessageId: "m1", serverMessageCount: 1,
      }, WORKSPACE_ID);

      expect(await getLastOpenConversation("agent_a", "chan_y", WORKSPACE_ID)).toBeNull();
      expect((await getLastOpenConversation("agent_a", "chan_x", WORKSPACE_ID))?.conversation_id).toBe("conv_1");
    });

    it("is scoped by agent — agent A channel x and agent B channel x are independent", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_a", newestMessageId: "ma", serverMessageCount: 1,
      }, WORKSPACE_ID);
      await setLastOpenConversation("agent_b", "chan_x", {
        conversation_id: "conv_b", newestMessageId: "mb", serverMessageCount: 1,
      }, WORKSPACE_ID);

      expect((await getLastOpenConversation("agent_a", "chan_x", WORKSPACE_ID))?.conversation_id).toBe("conv_a");
      expect((await getLastOpenConversation("agent_b", "chan_x", WORKSPACE_ID))?.conversation_id).toBe("conv_b");
    });

    it("null and undefined channel resolve to the same entry", async () => {
      await setLastOpenConversation("agent_a", null, {
        conversation_id: "conv_default", newestMessageId: "m1", serverMessageCount: 3,
      }, WORKSPACE_ID);

      const viaUndefined = await getLastOpenConversation("agent_a", undefined, WORKSPACE_ID);
      expect(viaUndefined?.conversation_id).toBe("conv_default");

      // Writing via undefined overwrites the same row read via null.
      await setLastOpenConversation("agent_a", undefined, {
        conversation_id: "conv_default2", newestMessageId: "m2", serverMessageCount: 4,
      }, WORKSPACE_ID);
      const viaNull = await getLastOpenConversation("agent_a", null, WORKSPACE_ID);
      expect(viaNull?.conversation_id).toBe("conv_default2");
    });

    it("returns null on cache miss", async () => {
      expect(await getLastOpenConversation("agent_missing", "chan", WORKSPACE_ID)).toBeNull();
    });

    it("clearLastOpenForConversation removes only the matching rows", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_1", newestMessageId: "m1", serverMessageCount: 1,
      }, WORKSPACE_ID);
      await setLastOpenConversation("agent_b", "chan_y", {
        conversation_id: "conv_1", newestMessageId: "m1", serverMessageCount: 1,
      }, WORKSPACE_ID);
      await setLastOpenConversation("agent_c", "chan_z", {
        conversation_id: "conv_2", newestMessageId: "m2", serverMessageCount: 1,
      }, WORKSPACE_ID);

      await clearLastOpenForConversation("conv_1", WORKSPACE_ID);

      expect(await getLastOpenConversation("agent_a", "chan_x", WORKSPACE_ID)).toBeNull();
      expect(await getLastOpenConversation("agent_b", "chan_y", WORKSPACE_ID)).toBeNull();
      // Pointer to conv_2 is untouched.
      expect((await getLastOpenConversation("agent_c", "chan_z", WORKSPACE_ID))?.conversation_id).toBe("conv_2");
    });

    // TC8 — the WS-driven refresh (task.created) may write serverMessageCount=0
    // when there is no local cache for a brand-new conversation. The store must
    // round-trip that 0 faithfully so the slow-path read's `serverMessageCount >
    // 0` gate sees it and falls back to the skeleton (never optimistically
    // paints empty/wrong content). This asserts the storage half of that
    // invariant; the read-site gate itself lives in agent-chat-view.tsx.
    it("TC8 — round-trips serverMessageCount=0 (non-poisoning WS-path write)", async () => {
      await setLastOpenConversation("agent_ws", "chan_x", {
        conversation_id: "conv_brand_new",
        newestMessageId: null,
        serverMessageCount: 0,
      }, WORKSPACE_ID);

      const entry = await getLastOpenConversation("agent_ws", "chan_x", WORKSPACE_ID);
      expect(entry?.conversation_id).toBe("conv_brand_new");
      // The read site gates optimism on `serverMessageCount > 0`; a stored 0
      // therefore disables the optimistic paint for this pointer.
      expect(entry?.serverMessageCount).toBe(0);
      expect(entry!.serverMessageCount > 0).toBe(false);
    });
  });

  describe("evictLRU", () => {
    it("keeps only the N most recently accessed conversations", async () => {
      const db = await openCacheDB(WORKSPACE_ID)!;

      // Write messages and meta directly to control lastAccessedAt precisely
      for (let i = 0; i < 5; i++) {
        await db.put("messages", makeMessage({ id: `m_${i}`, conversation_id: `conv_${i}`, created_at: `2024-01-0${i + 1}T00:00:00Z` }));
        await db.put("cache_meta", {
          conversation_id: `conv_${i}`,
          lastFetchedAt: Date.now(),
          lastAccessedAt: i * 1000,
          messageCount: 1,
          newestMessageId: `m_${i}`,
          hasMore: false,
          serverMessageCount: 0,
        });
      }

      await evictLRU(3);

      // Only the 3 most recently accessed should remain (conv_2, conv_3, conv_4)
      const meta0 = await getCacheMeta("conv_0", WORKSPACE_ID);
      const meta1 = await getCacheMeta("conv_1", WORKSPACE_ID);
      const meta2 = await getCacheMeta("conv_2", WORKSPACE_ID);
      const meta3 = await getCacheMeta("conv_3", WORKSPACE_ID);
      const meta4 = await getCacheMeta("conv_4", WORKSPACE_ID);

      expect(meta0).toBeNull();
      expect(meta1).toBeNull();
      expect(meta2).not.toBeNull();
      expect(meta3).not.toBeNull();
      expect(meta4).not.toBeNull();
    });

    it("prunes last_open pointers for evicted conversations (no dangling id)", async () => {
      const db = await openCacheDB(WORKSPACE_ID)!;

      for (let i = 0; i < 5; i++) {
        await db.put("messages", makeMessage({ id: `m_${i}`, conversation_id: `conv_${i}`, created_at: `2024-01-0${i + 1}T00:00:00Z` }));
        await db.put("cache_meta", {
          conversation_id: `conv_${i}`,
          lastFetchedAt: Date.now(),
          lastAccessedAt: i * 1000,
          messageCount: 1,
          newestMessageId: `m_${i}`,
          hasMore: false,
          serverMessageCount: 1,
        });
        await setLastOpenConversation(`agent_${i}`, "chan", {
          conversation_id: `conv_${i}`,
          newestMessageId: `m_${i}`,
          serverMessageCount: 1,
        }, WORKSPACE_ID);
      }

      await evictLRU(3);

      // conv_0 and conv_1 were evicted — their last_open pointers must be gone.
      expect(await getLastOpenConversation("agent_0", "chan", WORKSPACE_ID)).toBeNull();
      expect(await getLastOpenConversation("agent_1", "chan", WORKSPACE_ID)).toBeNull();
      // Survivors keep their pointers.
      expect((await getLastOpenConversation("agent_2", "chan", WORKSPACE_ID))?.conversation_id).toBe("conv_2");
      expect((await getLastOpenConversation("agent_4", "chan", WORKSPACE_ID))?.conversation_id).toBe("conv_4");
    });
  });

  describe("getCachedMessagesBefore", () => {
    it("returns older messages from cache correctly", async () => {
      const msgs = Array.from({ length: 10 }, (_, i) =>
        makeMessage({
          id: `m${i + 1}`,
          conversation_id: "conv_1",
          created_at: `2024-01-01T00:0${i}:00Z`,
        })
      );
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:06:00Z", "m7", 10, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    });

    it("respects limit parameter", async () => {
      const msgs = Array.from({ length: 20 }, (_, i) =>
        makeMessage({
          id: `m${String(i + 1).padStart(2, "0")}`,
          conversation_id: "conv_1",
          created_at: `2024-01-01T00:${String(i).padStart(2, "0")}:00Z`,
        })
      );
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:19:00Z", "m20", 5, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(5);
      expect(result!.messages.map((m) => m.id)).toEqual(["m15", "m16", "m17", "m18", "m19"]);
      expect(result!.hasMore).toBe(true);
    });

    it("hasMore is false when results exactly equal limit and meta.hasMore=false", async () => {
      const msgs = Array.from({ length: 6 }, (_, i) =>
        makeMessage({
          id: `m${i + 1}`,
          conversation_id: "conv_1",
          created_at: `2024-01-01T00:0${i}:00Z`,
        })
      );
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:05:00Z", "m6", 5, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(5);
      expect(result!.hasMore).toBe(false);
    });

    it("returns null when cache is incomplete (hasMore=true and fewer results than limit)", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, true, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, WORKSPACE_ID);
      expect(result).toBeNull();
    });

    it("returns partial results when cache is complete (hasMore=false)", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(result!.hasMore).toBe(false);
    });

    it("returns null for unknown conversation", async () => {
      const result = await getCachedMessagesBefore("nonexistent", "2024-01-01T00:00:00Z", "x", 10, WORKSPACE_ID);
      expect(result).toBeNull();
    });

    it("handles equal timestamps with ID tiebreaker", async () => {
      const msgs = [
        makeMessage({ id: "aaa", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "bbb", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "ccc", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:00:00Z", "ccc", 10, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages.map((m) => m.id)).toEqual(["aaa", "bbb"]);
    });

    it("filters out buffered and temp- messages", async () => {
      const db = await openCacheDB(WORKSPACE_ID)!;
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z", status: "buffered" }),
        makeMessage({ id: "temp-1", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:03:00Z" }),
        makeMessage({ id: "m4", conversation_id: "conv_1", created_at: "2024-01-01T00:04:00Z" }),
      ];
      // Write directly to include buffered/temp that mergeCachedMessages would filter
      for (const msg of msgs) {
        await db.put("messages", msg);
      }
      await db.put("cache_meta", {
        conversation_id: "conv_1",
        lastFetchedAt: Date.now(),
        lastAccessedAt: Date.now(),
        messageCount: 5,
        newestMessageId: "m4",
        hasMore: false,
        serverMessageCount: 0,
      });

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:04:00Z", "m4", 10, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
    });

    it("correctly excludes the cursor message itself", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, WORKSPACE_ID);
      expect(result).not.toBeNull();
      expect(result!.messages.every((m) => m.id !== "m3")).toBe(true);
    });

    it("no meta corruption on cache-hit path", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, WORKSPACE_ID);

      const metaBefore = await getCacheMeta("conv_1", WORKSPACE_ID);
      await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, WORKSPACE_ID);
      const metaAfter = await getCacheMeta("conv_1", WORKSPACE_ID);

      expect(metaAfter!.messageCount).toBe(metaBefore!.messageCount);
      expect(metaAfter!.hasMore).toBe(metaBefore!.hasMore);
      expect(metaAfter!.newestMessageId).toBe(metaBefore!.newestMessageId);
    });
  });

  describe("v2 → v3 migration", () => {
    it("upgrades an existing v2 DB to v3, adding last_open and preserving messages/cache_meta", async () => {
      // Use a dedicated workspace so we don't collide with the shared beforeEach DB.
      const MIGRATE_WS = "ws_migrate";
      await clearAllCache();

      // Build a v2-shaped DB by hand (only messages + cache_meta, version 2).
      const v2 = await openDB(`alook-chat-cache-${MIGRATE_WS}`, 2, {
        upgrade(db) {
          const msgStore = db.createObjectStore("messages", { keyPath: ["conversation_id", "id"] });
          msgStore.createIndex("by-conversation", "conversation_id", { unique: false });
          msgStore.createIndex("by-created", ["conversation_id", "created_at"], { unique: false });
          db.createObjectStore("cache_meta", { keyPath: "conversation_id" });
        },
      });
      await v2.put("messages", makeMessage({ id: "m1", conversation_id: "conv_old", created_at: "2024-01-01T00:00:00Z" }));
      await v2.put("cache_meta", {
        conversation_id: "conv_old",
        lastFetchedAt: 1,
        lastAccessedAt: 1,
        messageCount: 1,
        newestMessageId: "m1",
        hasMore: false,
        serverMessageCount: 1,
      });
      expect(v2.version).toBe(2);
      expect(v2.objectStoreNames.contains("last_open")).toBe(false);
      v2.close();

      // Open via the production code path — should upgrade to v3.
      const db = await openCacheDB(MIGRATE_WS)!;
      expect(db.version).toBe(3);
      expect(db.objectStoreNames.contains("last_open")).toBe(true);

      // Existing data is intact.
      const cached = await getCachedMessages("conv_old", MIGRATE_WS);
      expect(cached).toHaveLength(1);
      expect(cached![0].id).toBe("m1");
      const meta = await getCacheMeta("conv_old", MIGRATE_WS);
      expect(meta!.newestMessageId).toBe("m1");
      expect(meta!.serverMessageCount).toBe(1);

      // New store works.
      await setLastOpenConversation("agent_x", null, {
        conversation_id: "conv_old", newestMessageId: "m1", serverMessageCount: 1,
      }, MIGRATE_WS);
      expect((await getLastOpenConversation("agent_x", null, MIGRATE_WS))?.conversation_id).toBe("conv_old");

      await clearAllCache();
      openCacheDB(WORKSPACE_ID);
    });
  });

  describe("clearAllCache", () => {
    it("removes everything", async () => {
      await mergeCachedMessages(
        "conv_1",
        [makeMessage({ id: "m1", conversation_id: "conv_1" })],
        false,
        WORKSPACE_ID
      );
      await mergeCachedMessages(
        "conv_2",
        [makeMessage({ id: "m2", conversation_id: "conv_2" })],
        false,
        WORKSPACE_ID
      );

      await clearAllCache();

      const cached1 = await getCachedMessages("conv_1", WORKSPACE_ID);
      const cached2 = await getCachedMessages("conv_2", WORKSPACE_ID);
      expect(cached1).toBeNull();
      expect(cached2).toBeNull();
    });
  });
});
