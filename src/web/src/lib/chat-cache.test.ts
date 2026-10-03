import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";
import { createApplicationOwner } from "./application-owner";
import { createWorkspaceOwner, type WorkspaceOwner } from "@/contexts/workspace-context";
import { clearAllPersistedCaches } from "./query-persister";
import type { Message } from "@alook/shared";
import {
  getCachedMessages,
  getCachedMessagesBefore,
  mergeCachedMessages,
  appendCachedMessage,
  removeCachedMessage,
  getCacheMeta,
  invalidateCache,
  clearAllCache,
  getLastOpenConversation,
  setLastOpenConversation,
  clearLastOpenForConversation,
  getConvExtras,
  setConvExtras,
  clearConvExtras,
} from "./chat-cache";
import type { Artifact } from "@alook/shared";

const WORKSPACE_ID = "ws_test";

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: `art_${Math.random().toString(36).slice(2)}`,
    conversation_id: "conv_1",
    agent_id: "agent_a",
    filename: "report.pdf",
    content_type: "application/pdf",
    size: 1024,
    source: "agent",
    has_thumbnail: false,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeExtras(
  overrides: Partial<Parameters<typeof setConvExtras>[1]> = {},
): Parameters<typeof setConvExtras>[1] {
  return {
    artifacts: [makeArtifact()],
    conversation_type: "agent_chat",
    conversation_title: "My chat",
    conversation_channel: "general",
    conversation_created_at: "2024-01-01T00:00:00Z",
    hasMoreArtifacts: false,
    ...overrides,
  };
}

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

let cacheOwner: WorkspaceOwner;
beforeEach(async () => {
  await clearAllPersistedCaches();
  cacheOwner = createWorkspaceOwner(createApplicationOwner("cache-user"), WORKSPACE_ID, "test");
});

describe("chat-cache", () => {
  it("never reads an unqualified legacy workspace database", async () => {
    const legacy = await openDB(`alook-chat-cache-${WORKSPACE_ID}`, 4, { upgrade(db) { if (!db.objectStoreNames.contains("messages")) db.createObjectStore("messages", { keyPath: ["conversation_id", "id"] }); } });
    await legacy.put("messages", makeMessage({ id: "private", conversation_id: "legacy" }));
    expect(await getCachedMessages("legacy", cacheOwner)).toBeNull();
    legacy.close();
  });
  it("isolates identical workspace/conversation IDs across viewers and workspaces", async () => {
    await mergeCachedMessages("conv_1", [makeMessage({ id: "private" })], false, cacheOwner);
    const otherViewer = createWorkspaceOwner(createApplicationOwner("other"), WORKSPACE_ID, "test");
    const otherWorkspace = createWorkspaceOwner(cacheOwner.application, "different", "different");
    expect(await getCachedMessages("conv_1", otherViewer)).toBeNull();
    expect(await getCachedMessages("conv_1", otherWorkspace)).toBeNull();
  });
  it("rejects reads and writes from a retired original workspace", async () => {
    cacheOwner.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }));
    await expect(getCachedMessages("conv_1", cacheOwner)).rejects.toMatchObject({ name: "AbortError" });
    await expect(mergeCachedMessages("conv_1", [makeMessage()], false, cacheOwner)).rejects.toMatchObject({ name: "AbortError" });
  });


  describe("mergeCachedMessages", () => {
    it("writes messages and updates meta", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
      ];

      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
      expect(cached).toHaveLength(2);
      expect(cached![0].id).toBe("m1");
      expect(cached![1].id).toBe("m2");

      const meta = await getCacheMeta("conv_1", cacheOwner);
      expect(meta).not.toBeNull();
      expect(meta!.messageCount).toBeGreaterThanOrEqual(2);
      expect(meta!.hasMore).toBe(false);
    });

    it("merges without overwriting older messages", async () => {
      const older = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
      ];
      await mergeCachedMessages("conv_1", older, true, cacheOwner);

      const newer = [
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", newer, false, cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
      expect(cached).toHaveLength(3);
      expect(cached!.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });

    it("does not regress newestMessageId when merging older messages", async () => {
      const newer = [
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
        makeMessage({ id: "m4", conversation_id: "conv_1", created_at: "2024-01-01T00:03:00Z" }),
      ];
      await mergeCachedMessages("conv_1", newer, true, cacheOwner);

      const metaBefore = await getCacheMeta("conv_1", cacheOwner);
      expect(metaBefore!.newestMessageId).toBe("m4");

      const older = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
      ];
      await mergeCachedMessages("conv_1", older, null, cacheOwner);

      const metaAfter = await getCacheMeta("conv_1", cacheOwner);
      expect(metaAfter!.newestMessageId).toBe("m4");
      expect(metaAfter!.messageCount).toBe(4);
    });

    it("filters out temp- messages", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1" }),
        makeMessage({ id: "temp-123", conversation_id: "conv_1" }),
      ];

      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
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
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
      expect(cached![0].id).toBe("m1");
      expect(cached![1].id).toBe("m2");
    });

    it("returns null for unknown conversation", async () => {
      const cached = await getCachedMessages("nonexistent", cacheOwner);
      expect(cached).toBeNull();
    });

  });

  describe("appendCachedMessage", () => {
    it("adds single message without overwriting existing", async () => {
      const initial = [makeMessage({ id: "m1", conversation_id: "conv_1" })];
      await mergeCachedMessages("conv_1", initial, false, cacheOwner);

      await appendCachedMessage("conv_1", makeMessage({ id: "m2", conversation_id: "conv_1" }), cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
      expect(cached).toHaveLength(2);
    });

    it("skips temp- messages", async () => {
      const initial = [makeMessage({ id: "m1", conversation_id: "conv_1" })];
      await mergeCachedMessages("conv_1", initial, false, cacheOwner);

      await appendCachedMessage("conv_1", makeMessage({ id: "temp-abc", conversation_id: "conv_1" }), cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
      expect(cached).toHaveLength(1);
    });
  });

  describe("removeCachedMessage", () => {
    it("removes a single message by ID", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1" }),
        makeMessage({ id: "m2", conversation_id: "conv_1" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      await removeCachedMessage("conv_1", "m1", cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
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
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      await invalidateCache("conv_1", cacheOwner);

      const cached = await getCachedMessages("conv_1", cacheOwner);
      expect(cached).toBeNull();
      const meta = await getCacheMeta("conv_1", cacheOwner);
      expect(meta).toBeNull();
    });

    it("clears any last_open pointer referencing the invalidated conversation", async () => {
      await mergeCachedMessages("conv_1", [makeMessage({ id: "m1", conversation_id: "conv_1" })], false, cacheOwner);
      await setLastOpenConversation("agent_a", "chan", {
        conversation_id: "conv_1",
        newestMessageId: "m1",
        serverMessageCount: 1,
      }, cacheOwner);

      await invalidateCache("conv_1", cacheOwner);

      expect(await getLastOpenConversation("agent_a", "chan", cacheOwner)).toBeNull();
    });
  });

  describe("last_open pointer", () => {
    it("set then get round-trips for the same agent+channel", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_1",
        newestMessageId: "m9",
        serverMessageCount: 12,
      }, cacheOwner);

      const entry = await getLastOpenConversation("agent_a", "chan_x", cacheOwner);
      expect(entry).not.toBeNull();
      expect(entry!.conversation_id).toBe("conv_1");
      expect(entry!.newestMessageId).toBe("m9");
      expect(entry!.serverMessageCount).toBe(12);
    });

    it("is scoped by channel — a different channel returns null", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_1", newestMessageId: "m1", serverMessageCount: 1,
      }, cacheOwner);

      expect(await getLastOpenConversation("agent_a", "chan_y", cacheOwner)).toBeNull();
      expect((await getLastOpenConversation("agent_a", "chan_x", cacheOwner))?.conversation_id).toBe("conv_1");
    });

    it("is scoped by agent — agent A channel x and agent B channel x are independent", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_a", newestMessageId: "ma", serverMessageCount: 1,
      }, cacheOwner);
      await setLastOpenConversation("agent_b", "chan_x", {
        conversation_id: "conv_b", newestMessageId: "mb", serverMessageCount: 1,
      }, cacheOwner);

      expect((await getLastOpenConversation("agent_a", "chan_x", cacheOwner))?.conversation_id).toBe("conv_a");
      expect((await getLastOpenConversation("agent_b", "chan_x", cacheOwner))?.conversation_id).toBe("conv_b");
    });

    it("null and undefined channel resolve to the same entry", async () => {
      await setLastOpenConversation("agent_a", null, {
        conversation_id: "conv_default", newestMessageId: "m1", serverMessageCount: 3,
      }, cacheOwner);

      const viaUndefined = await getLastOpenConversation("agent_a", undefined, cacheOwner);
      expect(viaUndefined?.conversation_id).toBe("conv_default");

      // Writing via undefined overwrites the same row read via null.
      await setLastOpenConversation("agent_a", undefined, {
        conversation_id: "conv_default2", newestMessageId: "m2", serverMessageCount: 4,
      }, cacheOwner);
      const viaNull = await getLastOpenConversation("agent_a", null, cacheOwner);
      expect(viaNull?.conversation_id).toBe("conv_default2");
    });

    it("returns null on cache miss", async () => {
      expect(await getLastOpenConversation("agent_missing", "chan", cacheOwner)).toBeNull();
    });

    it("clearLastOpenForConversation removes only the matching rows", async () => {
      await setLastOpenConversation("agent_a", "chan_x", {
        conversation_id: "conv_1", newestMessageId: "m1", serverMessageCount: 1,
      }, cacheOwner);
      await setLastOpenConversation("agent_b", "chan_y", {
        conversation_id: "conv_1", newestMessageId: "m1", serverMessageCount: 1,
      }, cacheOwner);
      await setLastOpenConversation("agent_c", "chan_z", {
        conversation_id: "conv_2", newestMessageId: "m2", serverMessageCount: 1,
      }, cacheOwner);

      await clearLastOpenForConversation("conv_1", cacheOwner);

      expect(await getLastOpenConversation("agent_a", "chan_x", cacheOwner)).toBeNull();
      expect(await getLastOpenConversation("agent_b", "chan_y", cacheOwner)).toBeNull();
      // Pointer to conv_2 is untouched.
      expect((await getLastOpenConversation("agent_c", "chan_z", cacheOwner))?.conversation_id).toBe("conv_2");
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
      }, cacheOwner);

      const entry = await getLastOpenConversation("agent_ws", "chan_x", cacheOwner);
      expect(entry?.conversation_id).toBe("conv_brand_new");
      // The read site gates optimism on `serverMessageCount > 0`; a stored 0
      // therefore disables the optimistic paint for this pointer.
      expect(entry?.serverMessageCount).toBe(0);
      expect(entry!.serverMessageCount > 0).toBe(false);
    });
  });

  describe("conv_extras (card metadata)", () => {
    it("set then get round-trips artifacts array + conversation metadata", async () => {
      const arts = [
        makeArtifact({ id: "a1", conversation_id: "conv_1" }),
        makeArtifact({ id: "a2", conversation_id: "conv_1" }),
      ];
      await setConvExtras("conv_1", makeExtras({
        artifacts: arts,
        conversation_type: "email_notification",
        conversation_title: "Re: bug",
        conversation_channel: "inbox",
        conversation_created_at: "2024-02-02T00:00:00Z",
        hasMoreArtifacts: true,
      }), cacheOwner);

      const entry = await getConvExtras("conv_1", cacheOwner);
      expect(entry).not.toBeNull();
      expect(entry!.conversation_id).toBe("conv_1");
      expect(entry!.artifacts.map((a) => a.id)).toEqual(["a1", "a2"]);
      expect(entry!.conversation_type).toBe("email_notification");
      expect(entry!.conversation_title).toBe("Re: bug");
      expect(entry!.conversation_channel).toBe("inbox");
      expect(entry!.conversation_created_at).toBe("2024-02-02T00:00:00Z");
      expect(entry!.hasMoreArtifacts).toBe(true);
      // updatedAt is stamped at write time.
      expect(typeof entry!.updatedAt).toBe("number");
    });

    it("returns null for an unknown conversation", async () => {
      await setConvExtras("conv_1", makeExtras(), cacheOwner);
      expect(await getConvExtras("conv_other", cacheOwner)).toBeNull();
    });

    it("upserts — a second write replaces the row", async () => {
      await setConvExtras("conv_1", makeExtras({
        artifacts: [makeArtifact({ id: "a1" })],
        conversation_type: "agent_chat",
      }), cacheOwner);
      await setConvExtras("conv_1", makeExtras({
        artifacts: [makeArtifact({ id: "a2" }), makeArtifact({ id: "a3" })],
        conversation_type: "calendar_event",
      }), cacheOwner);

      const entry = await getConvExtras("conv_1", cacheOwner);
      expect(entry!.artifacts.map((a) => a.id)).toEqual(["a2", "a3"]);
      expect(entry!.conversation_type).toBe("calendar_event");
    });

    it("clearConvExtras removes only the target row", async () => {
      await setConvExtras("conv_1", makeExtras(), cacheOwner);
      await setConvExtras("conv_2", makeExtras(), cacheOwner);

      await clearConvExtras("conv_1", cacheOwner);

      expect(await getConvExtras("conv_1", cacheOwner)).toBeNull();
      expect(await getConvExtras("conv_2", cacheOwner)).not.toBeNull();
    });

    it("invalidateCache clears the conversation's conv_extras row", async () => {
      await mergeCachedMessages("conv_1", [makeMessage({ id: "m1", conversation_id: "conv_1" })], false, cacheOwner);
      await setConvExtras("conv_1", makeExtras(), cacheOwner);

      await invalidateCache("conv_1", cacheOwner);

      expect(await getConvExtras("conv_1", cacheOwner)).toBeNull();
    });

    it("clearAllCache removes conv_extras", async () => {
      await setConvExtras("conv_1", makeExtras(), cacheOwner);
      await clearAllCache(cacheOwner.application);
      expect(await getConvExtras("conv_1", cacheOwner)).toBeNull();
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
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:06:00Z", "m7", 10, cacheOwner);
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
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:19:00Z", "m20", 5, cacheOwner);
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
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:05:00Z", "m6", 5, cacheOwner);
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
      await mergeCachedMessages("conv_1", msgs, true, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, cacheOwner);
      expect(result).toBeNull();
    });

    it("returns partial results when cache is complete (hasMore=false)", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, cacheOwner);
      expect(result).not.toBeNull();
      expect(result!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(result!.hasMore).toBe(false);
    });

    it("returns null for unknown conversation", async () => {
      const result = await getCachedMessagesBefore("nonexistent", "2024-01-01T00:00:00Z", "x", 10, cacheOwner);
      expect(result).toBeNull();
    });

    it("handles equal timestamps with ID tiebreaker", async () => {
      const msgs = [
        makeMessage({ id: "aaa", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "bbb", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "ccc", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:00:00Z", "ccc", 10, cacheOwner);
      expect(result).not.toBeNull();
      expect(result!.messages.map((m) => m.id)).toEqual(["aaa", "bbb"]);
    });

    it("correctly excludes the cursor message itself", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const result = await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, cacheOwner);
      expect(result).not.toBeNull();
      expect(result!.messages.every((m) => m.id !== "m3")).toBe(true);
    });

    it("no meta corruption on cache-hit path", async () => {
      const msgs = [
        makeMessage({ id: "m1", conversation_id: "conv_1", created_at: "2024-01-01T00:00:00Z" }),
        makeMessage({ id: "m2", conversation_id: "conv_1", created_at: "2024-01-01T00:01:00Z" }),
        makeMessage({ id: "m3", conversation_id: "conv_1", created_at: "2024-01-01T00:02:00Z" }),
      ];
      await mergeCachedMessages("conv_1", msgs, false, cacheOwner);

      const metaBefore = await getCacheMeta("conv_1", cacheOwner);
      await getCachedMessagesBefore("conv_1", "2024-01-01T00:02:00Z", "m3", 10, cacheOwner);
      const metaAfter = await getCacheMeta("conv_1", cacheOwner);

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
        cacheOwner
      );
      await mergeCachedMessages(
        "conv_2",
        [makeMessage({ id: "m2", conversation_id: "conv_2" })],
        false,
        cacheOwner
      );

      await clearAllCache(cacheOwner.application);

      const cached1 = await getCachedMessages("conv_1", cacheOwner);
      const cached2 = await getCachedMessages("conv_2", cacheOwner);
      expect(cached1).toBeNull();
      expect(cached2).toBeNull();
    });
  });
});
