import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { queries } from "../src/index";
import type { Database } from "../src/index";
import { communityChannel, communityChannelMember, communityFriendship, communityMessage, communityReadState } from "../src/db/community-schema";
import { user } from "../src/db/schema";
import { getChannel } from "../src/db/queries/community/channel";
import { getChannelReadStateSnapshot } from "../src/db/queries/community/read-state";
import { createMigratedDb } from "./helpers/migrated-db";

it("restores an existing scoped cursor to the prior message in the hard deletion batch", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    await db.insert(user).values({ id: "writer", name: "Writer", email: "writer@delete.test" }).run();
    const firstAt = "2026-10-01T09:00:00Z";
    const latestAt = "2026-10-01T09:01:00Z";
    await db.insert(communityChannel).values([
      { id: "target", type: "text", messageCount: 2, lastMessageAt: latestAt },
      { id: "neighbor", type: "text", messageCount: 1, lastMessageAt: latestAt },
    ]).run();
    await db.insert(communityMessage).values([
      { id: "previous", channelId: "target", authorId: "writer", seq: 1, createdAt: firstAt },
      { id: "latest", channelId: "target", authorId: "writer", seq: 2, createdAt: latestAt },
      { id: "neighbor-message", channelId: "neighbor", authorId: "writer", seq: 2, createdAt: latestAt },
    ]).run();
    await db.insert(communityReadState).values([
      { userId: "writer", channelId: "target", lastReadMessageId: "latest", lastReadSeq: 2, lastReadAt: latestAt },
      { userId: "writer", channelId: "neighbor", lastReadMessageId: "neighbor-message", lastReadSeq: 2, lastReadAt: latestAt },
    ]).run();

    const identity = (channelId: string) => queries.communityMessage.getMessageIdentityByChannelAndSeq(db, { channelId }, 2);
    await expect(identity("target")).resolves.toEqual({ id: "latest", channelId: "target" });
    await expect(queries.communityMessage.hardDeleteMessage(db, "latest")).resolves.toEqual({
      readStateRevisions: [{ userId: "writer", revision: 1 }],
    });
    await expect(identity("target")).resolves.toBeNull();
    await expect(identity("neighbor")).resolves.toEqual({ id: "neighbor-message", channelId: "neighbor" });
    await expect(getChannel(db, "target")).resolves.toMatchObject({ messageCount: 1, lastMessageAt: firstAt });
    await expect(getChannelReadStateSnapshot(db, { userId: "writer", channelId: "target" })).resolves.toEqual({
      revision: 1, readState: { channelId: "target", lastReadMessageId: "previous", lastReadSeq: 1, lastReadAt: firstAt },
    });
    await expect(getChannelReadStateSnapshot(db, { userId: "writer", channelId: "neighbor" })).resolves.toEqual({
      revision: 1, readState: { channelId: "neighbor", lastReadMessageId: "neighbor-message", lastReadSeq: 2, lastReadAt: latestAt },
    });
    await expect(queries.communityMessage.hardDeleteMessage(db, "latest")).resolves.toBeNull();
  } finally {
    sqlite.close();
  }
});

it("hydrates only the access peers in DMs that reference the requested friendship", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    await db.insert(user).values(["left", "right", "other", "notified"].map(id => ({
      id, name: id, email: `${id}@friendship.test`,
    }))).run();
    await db.insert(communityFriendship).values([
      { id: "friendship", requesterId: "left", addresseeId: "right" },
      { id: "other-friendship", requesterId: "left", addresseeId: "other" },
    ]).run();
    await db.insert(communityChannel).values(["first-dm", "second-dm", "other-dm"].map(id => ({ id, type: "dm" }))).run();
    await db.insert(communityChannelMember).values([
      { channelId: "first-dm", userId: "left", relation: "access" },
      { channelId: "first-dm", userId: "right", relation: "access" },
      { channelId: "first-dm", userId: "notified", relation: "notify" },
      { channelId: "second-dm", userId: "right", relation: "access" },
      { channelId: "second-dm", userId: "other", relation: "access" },
      { channelId: "other-dm", userId: "notified", relation: "access" },
    ]).run();
    await db.insert(communityMessage).values([
      { id: "card-1", channelId: "first-dm", authorId: "left", friendshipId: "friendship", seq: 1 },
      { id: "card-2", channelId: "second-dm", authorId: "right", friendshipId: "friendship", seq: 1 },
      { id: "other-card", channelId: "other-dm", authorId: "left", friendshipId: "other-friendship", seq: 1 },
    ]).run();

    const cards = await queries.communityMessage.listMessagesReferencingFriendship(db, "friendship");
    expect(cards.map(card => ({ ...card, peerUserIds: card.peerUserIds.toSorted() })).toSorted((a, b) => a.messageId.localeCompare(b.messageId))).toEqual([
      { messageId: "card-1", channelId: "first-dm", peerUserIds: ["left", "right"] },
      { messageId: "card-2", channelId: "second-dm", peerUserIds: ["other", "right"] },
    ]);
    await expect(queries.communityMessage.listMessagesReferencingFriendship(db, "absent")).resolves.toEqual([]);
  } finally {
    sqlite.close();
  }
});

type SelectShape = "message" | "prior";
type Tag =
  | { kind: "revision" }
  | { kind: "delete-msg" }
  | { kind: "update-channel"; setValues?: Record<string, unknown> }
  | { kind: "update-dm"; setValues?: Record<string, unknown> }
  | { kind: "update-readstate"; setValues?: Record<string, unknown> }
  | { kind: "delete-readstate" };

interface MockState {
  batchCalls: Tag[][];
  selectQueue: Array<{ shape: SelectShape; rows: unknown[] }>;
  impactedQueue?: unknown[][];
  revisionRows?: Array<{ userId: string; revision: number }>;
  deletedRows?: Array<{ id: string }>;
}

function makeDb(state: MockState): Database {
  const mkBuilder = (tag: Tag) => {
    const b: any = { __tag: tag };
    b.set = (values: Record<string, unknown>) => {
      // Capture the set(...) payload so tests can assert on messageCount /
      // lastMessageAt / lastReadMessageId values, not just batch shape.
      (tag as { setValues?: Record<string, unknown> }).setValues = values;
      return b;
    };
    b.where = () => b;
    b.limit = () => b;
    b.orderBy = () => b;
    b.returning = () => b;
    return b;
  };

  const db: any = {
    select: () => {
      const b: any = {};
      b.from = () => b;
      b.where = () => b;
      b.orderBy = () => b;
      b.limit = () => {
        const next = state.selectQueue.shift();
        if (!next) throw new Error("unexpected select — selectQueue empty");
        return Promise.resolve(next.rows);
      };
      return b;
    },
    selectDistinct: () => {
      const b: any = {};
      b.from = () => b;
      b.innerJoin = () => b;
      b.where = () => {
        const rows = state.impactedQueue?.shift() ?? [];
        b.then = (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
        return b;
      };
      b.union = () => b;
      b.as = () => b;
      return b;
    },
    delete: (table: any) => {
      const name = getTableName(table);
      const tag: Tag = name.includes("read_state")
        ? { kind: "delete-readstate" }
        : { kind: "delete-msg" };
      return mkBuilder(tag);
    },
    insert: () => {
      const b = mkBuilder({ kind: "revision" });
      b.select = () => b;
      b.onConflictDoUpdate = () => b;
      return b;
    },
    update: (table: any) => {
      const name = getTableName(table);
      const tag: Tag = name.includes("read_state")
        ? { kind: "update-readstate" }
        : name.includes("dm_conversation")
        ? { kind: "update-dm" }
        : { kind: "update-channel" };
      return mkBuilder(tag);
    },
    batch: (stmts: any[]) => {
      state.batchCalls.push(stmts.map((s) => s.__tag as Tag));
      return Promise.resolve(stmts.map((statement) => (
        statement.__tag?.kind === "delete-msg"
          ? state.deletedRows ?? [{ id: "msg_1" }]
          : statement.__tag?.kind === "revision"
            ? state.revisionRows ?? []
            : []
      )));
    },
  };
  return db as Database;
}

describe("hardDeleteMessage — cascading rollback", () => {
  it("channel + prior message exists → repairs pointers before deleting the message", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [
            {
              id: "msg_1",
              channelId: "chan_1",
              dmConversationId: null,
              authorId: "user_1",
              seq: 5,
              createdAt: "2026-01-01T00:00:05Z",
            },
          ],
        },
        {
          shape: "prior",
          rows: [{ id: "msg_0", seq: 4, createdAt: "2026-01-01T00:00:04Z" }],
        },
      ],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1");
    expect(state.batchCalls).toHaveLength(1);
    const [upChan, upRs, del] = state.batchCalls[0]!;
    expect(upChan.kind).toBe("update-channel");
    expect(upRs.kind).toBe("update-readstate");
    expect(del.kind).toBe("delete-msg");
    // Regression guard for the plan's "CRITICAL" rule: messageCount must be a
    // SQL fragment / decrement expression, NOT a JS literal like `oldCount - 1`
    // (a concurrent inbound insert between the SELECT and this UPDATE would
    // otherwise get clobbered). Same story for lastMessageAt — must be an
    // inline MAX(createdAt) subquery, never a pre-fetched JS value.
    const chanSet = (upChan as { setValues?: Record<string, unknown> }).setValues!;
    expect(typeof chanSet.messageCount).toBe("object"); // Drizzle SQL fragment
    expect(typeof chanSet.lastMessageAt).toBe("object");
    expect(chanSet.messageCount).not.toBe(0); // not a pre-fetched literal
    // Read-state UPDATE must revert to the prior message's id/seq/createdAt.
    const rsSet = (upRs as { setValues?: Record<string, unknown> }).setValues!;
    expect(rsSet.lastReadMessageId).toBe("msg_0");
    expect(rsSet.lastReadSeq).toBe(4);
    expect(rsSet.lastReadAt).toBe("2026-01-01T00:00:04Z");
  });

  it("channel + NO prior message (first-ever sender) → removes pointers before deleting the message", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [
            {
              id: "msg_1",
              channelId: "chan_1",
              dmConversationId: null,
              authorId: "user_1",
              seq: 1,
              createdAt: "2026-01-01T00:00:01Z",
            },
          ],
        },
        { shape: "prior", rows: [] },
      ],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1");
    const kinds = state.batchCalls[0]!.map((t) => t.kind);
    expect(kinds).toEqual(["update-channel", "delete-readstate", "delete-msg"]);
  });

  it("DM channel + prior message → repairs pointers before deleting the message", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [
            {
              id: "msg_1",
              channelId: "dm_chan_1",
              authorId: "user_1",
              seq: 3,
              createdAt: "2026-01-01T00:00:03Z",
            },
          ],
        },
        {
          shape: "prior",
          rows: [{ id: "msg_0", seq: 2, createdAt: "2026-01-01T00:00:02Z" }],
        },
      ],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1");
    const [upChan, upRs] = state.batchCalls[0]!;
    const kinds = state.batchCalls[0]!.map((t) => t.kind);
    // DMs are channels now — the scope revert always targets communityChannel,
    // messageCount and all.
    expect(kinds).toEqual(["update-channel", "update-readstate", "delete-msg"]);
    const chanSet = (upChan as { setValues?: Record<string, unknown> }).setValues!;
    expect(typeof chanSet.messageCount).toBe("object"); // Drizzle SQL fragment
    expect(typeof chanSet.lastMessageAt).toBe("object"); // inline SQL subquery
    const rsSet = (upRs as { setValues?: Record<string, unknown> }).setValues!;
    expect(rsSet.lastReadMessageId).toBe("msg_0");
    expect(rsSet.lastReadSeq).toBe(2);
  });

  it("idempotent — SELECT returns no rows → no batch call, no throw", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [{ shape: "message", rows: [] }],
    };
    await queries.communityMessage.hardDeleteMessage(makeDb(state), "missing");
    expect(state.batchCalls).toHaveLength(0);
  });

  it("idempotent — target disappears after selection → no retry and no throw", async () => {
    const state: MockState = {
      batchCalls: [],
      selectQueue: [
        {
          shape: "message",
          rows: [{
            id: "msg_1",
            channelId: "chan_1",
            authorId: "user_1",
            seq: 1,
            createdAt: "2026-01-01T00:00:01Z",
          }],
        },
        { shape: "prior", rows: [] },
        { shape: "message", rows: [] },
      ],
      deletedRows: [],
    };

    await expect(
      queries.communityMessage.hardDeleteMessage(makeDb(state), "msg_1"),
    ).resolves.toBeNull();
    expect(state.batchCalls).toHaveLength(1);
  });

});
