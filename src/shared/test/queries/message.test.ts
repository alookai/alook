import { describe, it, expect, vi } from "vitest";
import * as messageQueries from "../../src/db/queries/message";
import { message } from "../../src/db/schema";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.delete = vi.fn(() => chain);
  return chain;
}

describe("message query module exports", () => {
  it("exports createMessage", () => {
    expect(typeof messageQueries.createMessage).toBe("function");
  });

  it("exports getNewestMessageId", () => {
    expect(typeof messageQueries.getNewestMessageId).toBe("function");
  });

  it("exports getActiveMessageCount", () => {
    expect(typeof messageQueries.getActiveMessageCount).toBe("function");
  });

  it("exports listMessages", () => {
    expect(typeof messageQueries.listMessages).toBe("function");
  });

  it("exports getMessage", () => {
    expect(typeof messageQueries.getMessage).toBe("function");
  });

  it("exports updateMessageTaskId", () => {
    expect(typeof messageQueries.updateMessageTaskId).toBe("function");
  });

  it("exports listMessagesAroundTask", () => {
    expect(typeof messageQueries.listMessagesAroundTask).toBe("function");
  });
});

describe("getNewestMessageId", () => {
  it("returns message id when messages exist", async () => {
    const mockDb = createMockDb([{ id: "msg_latest" }]);
    const result = await messageQueries.getNewestMessageId(mockDb, "conv_1");
    expect(result).toBe("msg_latest");
  });

  it("returns null when no messages exist", async () => {
    const mockDb = createMockDb([]);
    const result = await messageQueries.getNewestMessageId(mockDb, "conv_empty");
    expect(result).toBeNull();
  });
});

describe("getActiveMessageCount", () => {
  it("returns count from query result", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ cnt: 42 }]));
    const result = await messageQueries.getActiveMessageCount(chain, "conv_1");
    expect(result).toBe(42);
  });

  it("returns 0 when no rows returned", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    const result = await messageQueries.getActiveMessageCount(chain, "conv_empty");
    expect(result).toBe(0);
  });
});

describe("getMessage", () => {
  it("returns null when message not found", async () => {
    const mockDb = createMockDb([]);
    mockDb.where = vi.fn(() => Promise.resolve([]));
    const result = await messageQueries.getMessage(mockDb, "msg_missing");
    expect(result).toBeNull();
  });

  it("returns message when found", async () => {
    const msg = { id: "msg_1", content: "hello", role: "user" };
    const mockDb = createMockDb([msg]);
    mockDb.where = vi.fn(() => Promise.resolve([msg]));
    const result = await messageQueries.getMessage(mockDb, "msg_1");
    expect(result).toEqual(msg);
  });
});


// TC9 — the message.status column (default "active") and the
// idx_message_conversation_status index survive the buffer teardown.
describe("message schema (TC9)", () => {
  it("keeps the status column with default 'active'", () => {
    expect(message.status).toBeDefined();
    expect(message.status.name).toBe("status");
    expect(message.status.notNull).toBe(true);
    expect(message.status.default).toBe("active");
  });
});
