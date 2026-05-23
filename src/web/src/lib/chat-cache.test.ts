import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
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
