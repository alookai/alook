import { describe, it, expect, vi } from "vitest";
import * as readStateQueries from "../../src/db/queries/community/read-state";

// The builder variants are used inside `db.batch([...])` in the mark-channel-read
// route (see plans/21-community-tech-debt-pass-2.md finding #12). These tests
// pin the shape: `markChannelReadBuilder` must return the INSERT chain
// synchronously (no await) so it can be composed into a batch. Actual SQL
// behaviour is exercised in D1 integration runs.

function createInsertBuilderMock() {
  const chain: any = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  // Sentinel returned instead of a Promise — mimics Drizzle's builder shape.
  chain.onConflictDoUpdate = vi.fn(() => ({ __builder: "insert-onconflict" }));
  return chain;
}

describe("community/read-state exports", () => {
  it("exports markChannelReadBuilder", () => {
    expect(typeof readStateQueries.markChannelReadBuilder).toBe("function");
  });
});

describe("markChannelReadBuilder", () => {
  it("returns a builder synchronously (no await, no Promise)", () => {
    const db = createInsertBuilderMock();
    const result = readStateQueries.markChannelReadBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      lastReadAt: "2026-07-03T00:00:00Z",
    });
    // Must be a builder object, not a Promise — batch composition requires this.
    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledTimes(1);
    expect(db.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("passes lastReadAt + lastReadMessageId into both values and set clauses", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markChannelReadBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
    });
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({
      userId: "u_1",
      channelId: "c_1",
      dmConversationId: null,
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set).toMatchObject({
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
    });
  });

  it("defaults lastReadMessageId to null when omitted", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markChannelReadBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      lastReadAt: "2026-07-03T00:00:00Z",
    });
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg.lastReadMessageId).toBeNull();
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set.lastReadMessageId).toBeNull();
  });
});
