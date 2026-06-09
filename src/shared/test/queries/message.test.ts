import { describe, it, expect, vi } from "vitest";
import * as messageQueries from "../../src/db/queries/message";
import { message } from "../../src/db/schema";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
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

  it("exports getMessageForConversation", () => {
    expect(typeof messageQueries.getMessageForConversation).toBe("function");
  });

  it("exports updateMessageTaskId", () => {
    expect(typeof messageQueries.updateMessageTaskId).toBe("function");
  });

  it("exports listMessagesAroundTask", () => {
    expect(typeof messageQueries.listMessagesAroundTask).toBe("function");
  });

  it("exports getLatestNonEventMessage", () => {
    expect(typeof messageQueries.getLatestNonEventMessage).toBe("function");
  });

  it("exports getLatestBranchableMessage", () => {
    expect(typeof messageQueries.getLatestBranchableMessage).toBe("function");
  });

  it("exports isBranchableMessageRoot", () => {
    expect(typeof messageQueries.isBranchableMessageRoot).toBe("function");
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

describe("getLatestNonEventMessage", () => {
  it("returns the newest active non-event message", async () => {
    const latest = { id: "msg_latest", role: "assistant", status: "active" };
    const mockDb = createMockDb([latest]);

    const result = await messageQueries.getLatestNonEventMessage(
      mockDb,
      "conv_1",
    );

    expect(result).toEqual(latest);
    expect(mockDb.orderBy).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no active non-event message exists", async () => {
    const mockDb = createMockDb([]);

    const result = await messageQueries.getLatestNonEventMessage(
      mockDb,
      "conv_empty",
    );

    expect(result).toBeNull();
  });
});

describe("getLatestBranchableMessage", () => {
  it("returns the newest active user/assistant message with a completed session task", async () => {
    const latest = {
      id: "msg_latest",
      role: "assistant",
      status: "active",
      metadata: JSON.stringify({ kind: "dm" }),
    };
    const mockDb = createMockDb([{ msg: latest }]);

    const result = await messageQueries.getLatestBranchableMessage(
      mockDb,
      "conv_1",
    );

    expect(result).toEqual(latest);
    expect(mockDb.innerJoin).toHaveBeenCalled();
    expect(mockDb.orderBy).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(100);
  });

  it("skips transient/process rows and returns the previous complete reply", async () => {
    const previousComplete = {
      id: "msg_done",
      role: "assistant",
      status: "active",
      metadata: JSON.stringify({ kind: "dm" }),
    };
    const mockDb = createMockDb([
      {
        msg: {
          id: "msg_process",
          role: "assistant",
          status: "active",
          metadata: JSON.stringify({ kind: "process", transient: true }),
        },
      },
      { msg: previousComplete },
    ]);

    const result = await messageQueries.getLatestBranchableMessage(
      mockDb,
      "conv_1",
    );

    expect(result).toEqual(previousComplete);
  });

  it("returns null when no completed session-backed branchable message exists", async () => {
    const mockDb = createMockDb([]);

    const result = await messageQueries.getLatestBranchableMessage(
      mockDb,
      "conv_empty",
    );

    expect(result).toBeNull();
  });
});

describe("isBranchableMessageRoot", () => {
  it("accepts user roots, current assistant DM roots, and legacy assistant roots", () => {
    expect(
      messageQueries.isBranchableMessageRoot({
        role: "user",
        status: "active",
        metadata: null,
      }),
    ).toBe(true);
    expect(
      messageQueries.isBranchableMessageRoot({
        role: "assistant",
        status: "active",
        metadata: JSON.stringify({ kind: "dm" }),
      }),
    ).toBe(true);
  });

  it("accepts legacy assistant roots without a DM marker", () => {
    expect(
      messageQueries.isBranchableMessageRoot({
        role: "assistant",
        status: "active",
        metadata: null,
      }),
    ).toBe(true);
  });

  it("rejects transient/process roots", () => {
    expect(
      messageQueries.isBranchableMessageRoot({
        role: "assistant",
        status: "active",
        metadata: JSON.stringify({ kind: "progress", transient: true }),
      }),
    ).toBe(false);
  });

  it("rejects runtime error assistant rows", () => {
    expect(
      messageQueries.isBranchableMessageRoot({
        role: "assistant",
        status: "active",
        metadata: JSON.stringify({ error_source: "runtime" }),
      }),
    ).toBe(false);
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

describe("getMessageForConversation", () => {
  it("scopes the lookup by conversation id and message id", async () => {
    const msg = { id: "msg_1", conversationId: "conv_1", content: "hello" };
    const mockDb = createMockDb([msg]);

    const result = await messageQueries.getMessageForConversation(
      mockDb,
      "conv_1",
      "msg_1",
    );

    expect(result).toEqual(msg);
    expect(mockDb.where).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no scoped message matches", async () => {
    const mockDb = createMockDb([]);

    const result = await messageQueries.getMessageForConversation(
      mockDb,
      "conv_1",
      "msg_missing",
    );

    expect(result).toBeNull();
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
