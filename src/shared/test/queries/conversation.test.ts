import { describe, it, expect, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { desc } from "drizzle-orm";
import { CONVERSATION_TYPES } from "../../src/constants";
import { conversation } from "../../src/db/schema";
import * as conversationQueries from "../../src/db/queries/conversation";

const fakeDb = drizzle({} as never);

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  return chain;
}

function createOrderedMockDb(rows: any[]) {
  const calls: { select?: unknown; where?: unknown } = {};
  const chain: any = {};
  chain.select = vi.fn((selection?: unknown) => {
    calls.select = selection;
    return chain;
  });
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn((where: unknown) => {
    calls.where = where;
    return chain;
  });
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  chain.leftJoin = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  return { chain, calls };
}

describe("conversation query module exports", () => {
  it("exports createConversation", () => {
    expect(typeof conversationQueries.createConversation).toBe("function");
  });

  it("exports getConversation", () => {
    expect(typeof conversationQueries.getConversation).toBe("function");
  });

  it("exports getConversationsByIds", () => {
    expect(typeof conversationQueries.getConversationsByIds).toBe("function");
  });

  it("exports listConversations", () => {
    expect(typeof conversationQueries.listConversations).toBe("function");
  });

  it("exports listConversationsByAgent", () => {
    expect(typeof conversationQueries.listConversationsByAgent).toBe("function");
  });

  it("exports updateConversationTitle", () => {
    expect(typeof conversationQueries.updateConversationTitle).toBe("function");
  });

  it("exports getOrCreateAgentConversation", () => {
    expect(typeof conversationQueries.getOrCreateAgentConversation).toBe("function");
  });

  it("exports deleteConversation", () => {
    expect(typeof conversationQueries.deleteConversation).toBe("function");
  });

  it("exports listPreviousConversations", () => {
    expect(typeof conversationQueries.listPreviousConversations).toBe("function");
  });

  it("exports hasPreviousConversations", () => {
    expect(typeof conversationQueries.hasPreviousConversations).toBe("function");
  });
});

describe("conversation query function signatures (with optional channel param)", () => {
  it("listConversations accepts at least 3 params (db, workspaceId, userId) plus optional channel", () => {
    expect(conversationQueries.listConversations.length).toBeGreaterThanOrEqual(3);
  });

  it("listConversationsByAgent accepts at least 4 params plus optional channel", () => {
    expect(conversationQueries.listConversationsByAgent.length).toBeGreaterThanOrEqual(4);
  });

  it("getOrCreateAgentConversation accepts at least 4 params plus optional channel", () => {
    expect(conversationQueries.getOrCreateAgentConversation.length).toBeGreaterThanOrEqual(4);
  });

  it("listPreviousConversations accepts at least 5 params (db, workspaceId, userId, agentId, excludeId)", () => {
    expect(conversationQueries.listPreviousConversations.length).toBeGreaterThanOrEqual(5);
  });
});

describe("getConversationsByIds", () => {
  it("returns empty array for empty ids without querying DB", async () => {
    const result = await conversationQueries.getConversationsByIds(null as any, [], "ws_1");
    expect(result).toEqual([]);
  });
});

describe("getConversation", () => {
  it("returns null when not found", async () => {
    const mockDb = createMockDb([]);
    const result = await conversationQueries.getConversation(mockDb, "conv_missing", "ws_1");
    expect(result).toBeNull();
  });

  it("returns conversation when found", async () => {
    const conv = { id: "conv_1", title: "Test" };
    const mockDb = createMockDb([conv]);
    const result = await conversationQueries.getConversation(mockDb, "conv_1", "ws_1");
    expect(result).toEqual(conv);
  });
});

describe("listConversations", () => {
  it("filters normal conversation history to user DM conversations", async () => {
    const rows = [{ id: "conv_1", type: "user_dm_message" }];
    const { chain, calls } = createOrderedMockDb(rows);

    const result = await conversationQueries.listConversations(
      chain,
      "ws_1",
      "usr_1",
    );

    expect(result).toEqual(rows);
    expect(calls.where).toBeDefined();
    const { sql, params } = fakeDb
      .select()
      .from(conversation)
      .where(calls.where as any)
      .orderBy(desc(conversation.createdAt))
      .toSQL();

    expect(sql).toContain('"conversation"."type" = ?');
    expect(params).toEqual([
      "ws_1",
      "usr_1",
      CONVERSATION_TYPES.USER_DM_MESSAGE,
    ]);
  });
});

describe("listConversationsByAgent", () => {
  it("filters agent history to user DM conversations and selects type", async () => {
    const rows = [{ id: "conv_1", type: "user_dm_message" }];
    const { chain, calls } = createOrderedMockDb(rows);

    const result = await conversationQueries.listConversationsByAgent(
      chain,
      "ws_1",
      "usr_1",
      "ag_1",
    );

    expect(result).toEqual(rows);
    expect((calls.select as { type?: unknown }).type).toBe(conversation.type);
    expect(calls.where).toBeDefined();
    const { sql, params } = fakeDb
      .select()
      .from(conversation)
      .where(calls.where as any)
      .orderBy(desc(conversation.createdAt))
      .toSQL();

    expect(sql).toContain('"conversation"."type" = ?');
    expect(params).toEqual([
      "ws_1",
      "usr_1",
      "ag_1",
      CONVERSATION_TYPES.USER_DM_MESSAGE,
    ]);
  });
});

describe("updateConversationTitle", () => {
  it("returns null when no row updated", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    const result = await conversationQueries.updateConversationTitle(chain, "conv_1", "New Title");
    expect(result).toBeNull();
  });
});

describe("deleteConversation", () => {
  it("returns null when conversation does not exist", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    const result = await conversationQueries.deleteConversation(chain, "conv_missing", "ws_1");
    expect(result).toBeNull();
  });
});

describe("hasPreviousConversations", () => {
  it("returns true when previous conversations exist", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([{ exists: 1 }]));
    const result = await conversationQueries.hasPreviousConversations(chain, "ws_1", "usr_1", "ag_1", "conv_current");
    expect(result).toBe(true);
  });

  it("returns false when no previous conversations exist", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    const result = await conversationQueries.hasPreviousConversations(chain, "ws_1", "usr_1", "ag_1", "conv_current");
    expect(result).toBe(false);
  });
});
