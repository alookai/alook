import { describe, it, expect, vi } from "vitest";
import * as inboxQueries from "../../src/db/queries/inbox";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.all = vi.fn(() => Promise.resolve(rows));
  chain.run = vi.fn(() => Promise.resolve());
  return chain;
}

describe("inbox exports", () => {
  it("exports listUnreadConversations", () => { expect(typeof inboxQueries.listUnreadConversations).toBe("function"); });
  it("exports getUnreadCount", () => { expect(typeof inboxQueries.getUnreadCount).toBe("function"); });
  it("exports markConversationRead", () => { expect(typeof inboxQueries.markConversationRead).toBe("function"); });
  it("exports markAllConversationsRead", () => { expect(typeof inboxQueries.markAllConversationsRead).toBe("function"); });
});

describe("listUnreadConversations", () => {
  it("returns items and hasMore=false when rows <= limit", async () => {
    const rows = [{ id: "c_1" }];
    const mockDb = createMockDb(rows);
    const result = await inboxQueries.listUnreadConversations(mockDb, "u", "w");
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
});

describe("getUnreadCount", () => {
  it("returns 0 when empty", async () => { expect(await inboxQueries.getUnreadCount(createMockDb([]), "u", "w")).toBe(0); });
  it("returns count", async () => { expect(await inboxQueries.getUnreadCount(createMockDb([{ count: 5 }]), "u", "w")).toBe(5); });
  it("handles custom types", async () => { expect(await inboxQueries.getUnreadCount(createMockDb([{ count: 2 }]), "u", "w", ["email_notification"])).toBe(2); });
});

describe("markConversationRead", () => {
  it("calls db.run", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.markConversationRead(mockDb, "u", "c");
    expect(mockDb.run).toHaveBeenCalled();
  });
});

describe("markAllConversationsRead", () => {
  it("calls db.run", async () => {
    const mockDb = createMockDb([]);
    await inboxQueries.markAllConversationsRead(mockDb, "u", "w");
    expect(mockDb.run).toHaveBeenCalled();
  });
});
