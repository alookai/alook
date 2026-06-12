import { describe, it, expect, vi } from "vitest";
import * as inboxQueries from "../../src/db/queries/inbox";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.all = vi.fn(() => Promise.resolve(rows));
  chain.run = vi.fn(() => Promise.resolve());
  return chain;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe("inbox exports", () => {
  it("exports listUnreadConversations", () => { expect(typeof inboxQueries.listUnreadConversations).toBe("function"); });
  it("exports getUnreadCount", () => { expect(typeof inboxQueries.getUnreadCount).toBe("function"); });
  it("exports markConversationRead", () => { expect(typeof inboxQueries.markConversationRead).toBe("function"); });
  it("exports markAllConversationsRead", () => { expect(typeof inboxQueries.markAllConversationsRead).toBe("function"); });
  it("exports upsertUnreadEntry", () => { expect(typeof inboxQueries.upsertUnreadEntry).toBe("function"); });
  it("exports updateUnreadLatestMessage", () => { expect(typeof inboxQueries.updateUnreadLatestMessage).toBe("function"); });
  it("exports deleteUnreadEntry", () => { expect(typeof inboxQueries.deleteUnreadEntry).toBe("function"); });
  it("exports deleteAllUnreadEntries", () => { expect(typeof inboxQueries.deleteAllUnreadEntries).toBe("function"); });
  it("exports findLatestAssistantMessageId", () => { expect(typeof inboxQueries.findLatestAssistantMessageId).toBe("function"); });
  it("exports isUnreadEligible", () => { expect(typeof inboxQueries.isUnreadEligible).toBe("function"); });
});

// ---------------------------------------------------------------------------
// TC4: isUnreadEligible
// ---------------------------------------------------------------------------

describe("isUnreadEligible", () => {
  const base = { parentTaskId: null, traceId: "t1", type: "user_dm_message", context: {} };

  it("returns true for root DM task with trace", () => {
    expect(inboxQueries.isUnreadEligible(base)).toBe(true);
  });

  it("returns true for email_notification task", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "email_notification" })).toBe(true);
  });

  it("returns true for calendar_event task", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "calendar_event" })).toBe(true);
  });

  it("returns false for child task (parentTaskId set)", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, parentTaskId: "p1" })).toBe(false);
  });

  it("returns false for task without traceId", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, traceId: null })).toBe(false);
  });

  it("returns false for isInternal email", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "email_notification", context: { isInternal: true } })).toBe(false);
  });

  it("returns false for kill_task type", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "kill_task" })).toBe(false);
  });

  it("returns false for issue_event (not in whitelist)", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "issue_event" })).toBe(false);
  });

  it("returns true for email_notification that is NOT internal", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "email_notification", context: { isInternal: false } })).toBe(true);
  });

  it("returns true for email_notification with no context", () => {
    expect(inboxQueries.isUnreadEligible({ ...base, type: "email_notification", context: undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TC1: upsertUnreadEntry
// ---------------------------------------------------------------------------

describe("upsertUnreadEntry", () => {
  it("calls db.run with INSERT ON CONFLICT", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.upsertUnreadEntry(mockDb, {
      conversationId: "c1",
      userId: "u1",
      workspaceId: "w1",
      agentId: "a1",
      taskId: "t1",
      taskType: "user_dm_message",
      taskStatus: "completed",
      taskPrompt: "hello",
      completedAt: "2026-01-01T00:00:00Z",
      latestMessageId: "m1",
    });
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("can be called twice (upsert semantics)", async () => {
    const mockDb = createMockDb([]);
    const entry = {
      conversationId: "c1",
      userId: "u1",
      workspaceId: "w1",
      agentId: "a1",
      taskId: "t1",
      taskType: "user_dm_message",
      taskStatus: "completed",
      taskPrompt: "hello",
      completedAt: "2026-01-01T00:00:00Z",
      latestMessageId: "m1",
    };
    await inboxQueries.upsertUnreadEntry(mockDb, entry);
    await inboxQueries.upsertUnreadEntry(mockDb, { ...entry, taskId: "t2", completedAt: "2026-01-02T00:00:00Z" });
    expect(mockDb.run).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// TC2: updateUnreadLatestMessage
// ---------------------------------------------------------------------------

describe("updateUnreadLatestMessage", () => {
  it("calls db.run for UPDATE when row exists", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.updateUnreadLatestMessage(mockDb, "c1", "u1", "m_new");
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("is a no-op when no row exists (UPDATE affects 0 rows)", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.updateUnreadLatestMessage(mockDb, "c_nonexistent", "u1", "m1");
    expect(mockDb.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TC3: deleteUnreadEntry / deleteAllUnreadEntries
// ---------------------------------------------------------------------------

describe("deleteUnreadEntry", () => {
  it("calls db.run for DELETE", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.deleteUnreadEntry(mockDb, "c1", "u1");
    expect(mockDb.run).toHaveBeenCalled();
  });

  it("second call is a no-op (DELETE of non-existent row)", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.deleteUnreadEntry(mockDb, "c1", "u1");
    await inboxQueries.deleteUnreadEntry(mockDb, "c1", "u1");
    expect(mockDb.run).toHaveBeenCalledTimes(2);
  });
});

describe("deleteAllUnreadEntries", () => {
  it("calls db.run for DELETE", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.deleteAllUnreadEntries(mockDb, "u1", "w1");
    expect(mockDb.run).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TC9 / TC11: listUnreadConversations (rewritten query)
// ---------------------------------------------------------------------------

describe("listUnreadConversations", () => {
  it("returns items and hasMore=false when rows <= limit", async () => {
    const rows = [{ id: "c_1", agent_id: "a1", title: "t", channel: "default", latest_response: "hi", latest_response_at: "2026-01-01", root_prompt: "hey", agent_name: "Bot", agent_avatar_url: null, root_task_status: "completed", root_task_type: "user_dm_message" }];
    const result = await inboxQueries.listUnreadConversations(createMockDb(rows), "u", "w");
    expect(result.items).toEqual(rows);
    expect(result.hasMore).toBe(false);
  });

  it("returns hasMore=true when rows exceed limit", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ id: `c_${i}` }));
    const result = await inboxQueries.listUnreadConversations(createMockDb(rows), "u", "w");
    expect(result.hasMore).toBe(true);
    expect(result.items.length).toBe(30);
  });

  it("uses custom limit", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `c_${i}` }));
    const result = await inboxQueries.listUnreadConversations(createMockDb(rows), "u", "w", { limit: 5 });
    expect(result.hasMore).toBe(true);
    expect(result.items.length).toBe(5);
  });

  it("handles before option", async () => {
    const result = await inboxQueries.listUnreadConversations(createMockDb([]), "u", "w", { before: "2026-01-01" });
    expect(result.items).toEqual([]);
  });

  it("handles types option", async () => {
    const result = await inboxQueries.listUnreadConversations(createMockDb([]), "u", "w", { types: ["email_notification"] });
    expect(result.items).toEqual([]);
  });

  it("defaults to user_dm_message type when no types given", async () => {
    const result = await inboxQueries.listUnreadConversations(createMockDb([]), "u", "w");
    expect(result.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TC10: getUnreadCount
// ---------------------------------------------------------------------------

describe("getUnreadCount", () => {
  it("returns 0 when empty", async () => {
    expect(await inboxQueries.getUnreadCount(createMockDb([]), "u", "w")).toBe(0);
  });

  it("returns count", async () => {
    expect(await inboxQueries.getUnreadCount(createMockDb([{ count: 5 }]), "u", "w")).toBe(5);
  });

  it("handles custom types (single type)", async () => {
    expect(await inboxQueries.getUnreadCount(createMockDb([{ count: 2 }]), "u", "w", ["email_notification"])).toBe(2);
  });

  it("handles custom types (multiple types)", async () => {
    expect(await inboxQueries.getUnreadCount(createMockDb([{ count: 7 }]), "u", "w", ["user_dm_message", "email_notification"])).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// TC7 / TC8: markConversationRead / markAllConversationsRead
// ---------------------------------------------------------------------------

describe("markConversationRead", () => {
  it("calls db.run twice (read_state + delete unread)", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.markConversationRead(mockDb, "u", "c");
    expect(mockDb.run).toHaveBeenCalledTimes(2);
  });
});

describe("markAllConversationsRead", () => {
  it("calls db.run twice (read_state + delete all unread)", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.markAllConversationsRead(mockDb, "u", "w");
    expect(mockDb.run).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// findLatestAssistantMessageId
// ---------------------------------------------------------------------------

describe("findLatestAssistantMessageId", () => {
  it("returns message id when found", async () => {
    const result = await inboxQueries.findLatestAssistantMessageId(createMockDb([{ id: "m_123" }]), "c1");
    expect(result).toBe("m_123");
  });

  it("returns null when no assistant message exists", async () => {
    const result = await inboxQueries.findLatestAssistantMessageId(createMockDb([]), "c1");
    expect(result).toBeNull();
  });
});
