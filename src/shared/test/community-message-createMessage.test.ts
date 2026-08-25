import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";
import { queries } from "../src/index";
import type { Database } from "../src/index";

/**
 * Structural guard for the D1 write transaction. The seq reservation is not
 * allowed to commit separately from the message, author cursor, or human
 * read-state revision that makes the send visible.
 */

type BuilderTag =
  | { kind: "insert-seq" }
  | { kind: "insert-msg"; values: Record<string, unknown> }
  | { kind: "update-channel" }
  | { kind: "insert-readstate"; values: Record<string, unknown> }
  | { kind: "insert-revision" };

interface MockDb {
  batchCalls: Array<BuilderTag[]>;
}

function makeMockDb(currentSeq: number): { db: Database; state: MockDb } {
  const state: MockDb = { batchCalls: [] };

  const builder = (tag: BuilderTag) => {
    const value: any = { __tag: tag };
    value.values = (values: Record<string, unknown>) => {
      if ("values" in tag) tag.values = values;
      return value;
    };
    value.set = () => value;
    value.where = () => value;
    value.onConflictDoUpdate = () => value;
    value.returning = () => value;
    return value;
  };

  const db: any = {
    select: () => {
      const value: any = {};
      value.from = () => value;
      value.where = () => Promise.resolve([{ nextSeq: currentSeq }]);
      return value;
    },
    insert: (table: any) => {
      const name = getTableName(table);
      if (name.includes("message_seq")) return builder({ kind: "insert-seq" });
      if (name.includes("read_state_revision")) return builder({ kind: "insert-revision" });
      if (name.includes("read_state")) {
        return builder({ kind: "insert-readstate", values: {} });
      }
      return builder({ kind: "insert-msg", values: {} });
    },
    update: () => builder({ kind: "update-channel" }),
    batch: async (statements: any[]) => {
      const tags = statements.map((statement) => statement.__tag as BuilderTag);
      state.batchCalls.push(tags);
      return tags.map((tag) => {
        if (tag.kind === "insert-msg") return [tag.values];
        if (tag.kind === "insert-revision") return [{ revision: 3 }];
        return undefined;
      });
    },
  };

  return { db: db as Database, state };
}

describe("createMessage — atomic batch composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["channel", "chan_1"],
    ["DM channel", "dm_chan_1"],
  ])("%s bot send batches seq, message, scope, and read-state together", async (_, channelId) => {
    const { db, state } = makeMockDb(41);
    const msg = await queries.communityMessage.createMessage(db, {
      id: "msg_test",
      authorId: "bot_1",
      authorKind: "bot",
      content: "hello",
      channelId,
    });

    expect(state.batchCalls).toHaveLength(1);
    expect(state.batchCalls[0]!.map((tag) => tag.kind)).toEqual([
      "insert-seq",
      "insert-msg",
      "update-channel",
      "insert-readstate",
    ]);
    const cursor = state.batchCalls[0]!.find(
      (tag): tag is Extract<BuilderTag, { kind: "insert-readstate" }> =>
        tag.kind === "insert-readstate"
    );
    expect(cursor?.values).toMatchObject({
      channelId,
      lastReadSeq: 42,
      lastReadMessageId: "msg_test",
    });
    expect(msg).toMatchObject({ id: "msg_test", seq: 42, channelId });
  });

  it("human send appends its revision to the same atomic batch", async () => {
    const { db, state } = makeMockDb(8);
    const msg = await queries.communityMessage.createMessage(db, {
      id: "human_msg",
      authorId: "human_1",
      authorKind: "human",
      content: "hello from another device",
      channelId: "chan_1",
    });

    expect(state.batchCalls[0]!.map((tag) => tag.kind)).toEqual([
      "insert-seq",
      "insert-msg",
      "update-channel",
      "insert-readstate",
      "insert-revision",
    ]);
    expect(msg).toMatchObject({ id: "human_msg", seq: 9, readStateRevision: 3 });
  });

  it("human forum opener uses the same atomic cursor and revision contract", async () => {
    const { db, state } = makeMockDb(12);
    const msg = await queries.communityMessage.createMessage(db, {
      id: "forum_msg",
      authorId: "human_1",
      authorKind: "human",
      content: "A new forum post",
      channelId: "forum_1",
    });

    const cursor = state.batchCalls[0]!.find(
      (tag): tag is Extract<BuilderTag, { kind: "insert-readstate" }> =>
        tag.kind === "insert-readstate"
    );
    expect(cursor?.values).toMatchObject({
      userId: "human_1",
      channelId: "forum_1",
      lastReadMessageId: "forum_msg",
      lastReadSeq: 13,
    });
    expect(msg).toMatchObject({ seq: 13, readStateRevision: 3 });
  });
});
