import { describe, it, expect, vi } from "vitest";
import { nanoid } from "nanoid";
import * as messageQueries from "../../src/db/queries/community/message";
import {
  communityMessage,
  communityChannel,
  communityReadState,
  communityMessageSeq,
} from "../../src/db/community-schema";

vi.mock("nanoid", () => ({ nanoid: vi.fn(() => "m_generated") }));

describe("community/message exports", () => {
  it("exports getMessagesByIds", () => {
    expect(typeof messageQueries.getMessagesByIds).toBe("function");
  });
  it("exports createMessage", () => {
    expect(typeof messageQueries.createMessage).toBe("function");
  });
});

describe("getMessageIdentityByChannelAndSeq", () => {
  it("projects only message identity for channel-scoped resolution", async () => {
    const db = createSelectMock([{ id: "m_42", channelId: "ch_1" }]);
    await expect(messageQueries.getMessageIdentityByChannelAndSeq(
      db,
      { channelId: "ch_1" },
      42,
    )).resolves.toEqual({ id: "m_42", channelId: "ch_1" });
    expect(db.select).toHaveBeenCalledWith({
      id: communityMessage.id,
      channelId: communityMessage.channelId,
    });
  });
});

describe("updateOwnMessageContent", () => {
  it("guards the UPDATE by both message id and author id", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([{ id: "m1", channelId: "c1", content: "new" }]));
    const result = await messageQueries.updateOwnMessageContent(chain, {
      messageId: "m1", authorId: "u1", content: "new",
    });
    expect(chain.set).toHaveBeenCalledWith({ content: "new" });
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "m1", channelId: "c1", content: "new" });
  });
});

function messageRow(id: string) {
  return {
    id,
    authorId: `u_${id}`,
    content: `hi from ${id}`,
    type: "default",
    mentionType: null,
    replyToId: null,
    embeds: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    channelId: "ch_1",
    authorName: `User ${id}`,
    authorEmail: `${id}@x.com`,
    authorImage: null,
  };
}

// Terminal-where mock: `.where()` resolves to rows. Also records call order to
// prove `.orderBy` is never invoked (per plan §4 — unordered).
function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("getMessagesByIds", () => {
  it("returns [] and does NOT hit db when ids is empty", async () => {
    const db = createSelectMock([messageRow("m_1")]);
    const result = await messageQueries.getMessagesByIds(db, []);
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does not call orderBy — rows returned unordered", async () => {
    const db = createSelectMock([messageRow("m_1")]);
    await messageQueries.getMessagesByIds(db, ["m_1"]);
    expect(db.orderBy).not.toHaveBeenCalled();
  });

  it("silently drops unknown ids: length matches DB result, not input length", async () => {
    // 3 ids requested, only 2 rows come back — no throw, length matches rows.
    const db = createSelectMock([messageRow("m_1"), messageRow("m_2")]);
    const result = await messageQueries.getMessagesByIds(db, ["m_1", "m_2", "m_missing"]);
    expect(result).toHaveLength(2);
  });

  it("returned rows carry the getMessage projection, no extras", async () => {
    const db = createSelectMock([messageRow("m_1")]);
    const result = await messageQueries.getMessagesByIds(db, ["m_1"]);
    expect(result).toHaveLength(1);
    const keys = Object.keys(result[0]!).sort();
    expect(keys).toEqual(
      [
        "authorEmail",
        "authorId",
        "authorImage",
        "authorName",
        "channelId",
        "content",
        "createdAt",
        "embeds",
        "id",
        "mentionType",
        "replyToId",
        "type",
      ].sort()
    );
  });

  it("innerJoin(user) is applied — mirrors getMessage projection", async () => {
    const db = createSelectMock([]);
    await messageQueries.getMessagesByIds(db, ["m_1"]);
    expect(db.innerJoin).toHaveBeenCalledTimes(1);
  });
});

describe("getMessageInScope", () => {
  it("exports as a function", () => {
    expect(typeof messageQueries.getMessageInScope).toBe("function");
  });

  it("returns the row when the db finds an in-scope match", async () => {
    const db = createSelectMock([messageRow("m_1")]);
    const result = await messageQueries.getMessageInScope(db, "m_1", { channelId: "ch_1" });
    expect(result?.id).toBe("m_1");
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it("returns null when the db finds no in-scope match", async () => {
    const db = createSelectMock([]);
    const result = await messageQueries.getMessageInScope(db, "m_other", { channelId: "ch_1" });
    expect(result).toBeNull();
  });

  it("accepts a DM channel scope (a DM is a type=dm channel, addressed by channelId)", async () => {
    const row = { ...messageRow("m_dm"), channelId: "dm_ch_1" };
    const db = createSelectMock([row]);
    const result = await messageQueries.getMessageInScope(db, "m_dm", {
      channelId: "dm_ch_1",
    });
    expect(result?.channelId).toBe("dm_ch_1");
  });
});

describe("getMessagesByIdsInScope", () => {
  it("exports as a function", () => {
    expect(typeof messageQueries.getMessagesByIdsInScope).toBe("function");
  });

  it("returns [] and does NOT hit db when ids is empty", async () => {
    const db = createSelectMock([messageRow("m_1")]);
    const result = await messageQueries.getMessagesByIdsInScope(db, [], { channelId: "ch_1" });
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns only rows the db resolves in-scope", async () => {
    const db = createSelectMock([messageRow("m_1")]);
    const result = await messageQueries.getMessagesByIdsInScope(
      db,
      ["m_1", "m_leak"],
      { channelId: "ch_1" },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("m_1");
    expect(db.where).toHaveBeenCalledTimes(1);
  });
});

/**
 * Captures each `db.insert(...)` and `db.update(...)` call in order so tests
 * can inspect which table was hit with which values/set/onConflict clauses.
 *
 * `insert(table).values(v).returning()` resolves to `[{...v, id: v.id ?? generatedId}]`
 * so the caller can read `msg.createdAt` and `msg.id` off the inserted row.
 * The mock also models the seq counter and records committed batches so a
 * losing compare-and-swap can be distinguished from builder construction.
 */
type MockStatement = Promise<unknown> & { __kind?: string; __seq?: number };

function mockStatement(result: unknown, kind: string, seq?: number): MockStatement {
  return Object.assign(Promise.resolve(result), { __kind: kind, __seq: seq });
}

function seqUniqueError() {
  return new Error(
    "D1_ERROR: UNIQUE constraint failed: community_message.channel_id, community_message.seq"
  );
}

function createCreateMessageDbMock(opts?: {
  messageId?: string;
  currentSeq?: number;
  batchFailures?: Array<{ error: unknown; issuedSeqAfter?: number } | null>;
}) {
  const inserts: Array<{ table: unknown; values?: any; onConflict?: any }> = [];
  const updates: Array<{ table: unknown; set?: any; where?: any }> = [];
  const generatedId = opts?.messageId ?? "m_generated";
  vi.mocked(nanoid).mockReturnValue(generatedId);
  const seqByScope = new Map<string, number>();
  const batches: MockStatement[][] = [];
  const committedBatches: MockStatement[][] = [];
  let batchAttempt = 0;

  if (opts?.currentSeq !== undefined) {
    seqByScope.set("ch_1", opts.currentSeq);
    seqByScope.set("dm_ch_1", opts.currentSeq);
  }

  const db: any = {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => {
        const first = seqByScope.entries().next().value as [string, number] | undefined;
        return Promise.resolve(first ? [{ nextSeq: first[1] }] : []);
      });
      return chain;
    }),
    insert: vi.fn((table: unknown) => {
      // Keep the counter statement out of `__inserts`: assertions below use
      // that collection for the message and read-state payloads only.
      if (table === communityMessageSeq) {
        return {
          values: vi.fn((v: any) => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(() =>
                mockStatement([{ nextSeq: v.nextSeq }], "seq", v.nextSeq)
              ),
            })),
          })),
        };
      }
      const rec: { table: unknown; values?: any; onConflict?: any } = { table };
      inserts.push(rec);
      return {
        values: vi.fn((v: any) => {
          rec.values = v;
          return {
            returning: vi.fn(() =>
              mockStatement([{ ...v, id: v.id ?? generatedId }], "message", v.seq)
            ),
            onConflictDoUpdate: vi.fn((cfg: any) => {
              rec.onConflict = cfg;
              return mockStatement(undefined, "read-state", v.lastReadSeq);
            }),
          };
        }),
      };
    }),
    update: vi.fn((table: unknown) => {
      const rec: { table: unknown; set?: any; where?: any } = { table };
      updates.push(rec);
      return {
        set: vi.fn((s: any) => {
          rec.set = s;
          return {
            where: vi.fn((w: any) => {
              rec.where = w;
              return mockStatement(undefined, "channel-update");
            }),
          };
        }),
      };
    }),
    batch: vi.fn(async (stmts: MockStatement[]) => {
      batches.push(stmts);
      const scriptedFailure = opts?.batchFailures?.[batchAttempt++];
      if (scriptedFailure) {
        if (scriptedFailure.issuedSeqAfter !== undefined) {
          const seqStmt = stmts.find((stmt) => stmt.__kind === "seq");
          const channelId = inserts.find((rec) => rec.table === communityMessage)?.values
            ?.channelId ?? "ch_1";
          seqByScope.set(channelId, scriptedFailure.issuedSeqAfter);
          if (seqStmt?.__seq !== undefined && scriptedFailure.issuedSeqAfter < seqStmt.__seq) {
            seqByScope.set(channelId, seqStmt.__seq);
          }
        }
        throw scriptedFailure.error;
      }

      const messageStmt = stmts.find((stmt) => stmt.__kind === "message");
      const messageInsert = inserts.filter((rec) => rec.table === communityMessage).at(-1);
      const channelId = messageInsert?.values?.channelId ?? "ch_1";
      const currentSeq = seqByScope.get(channelId) ?? 0;
      const proposedSeq = messageStmt?.__seq ?? 0;
      if (proposedSeq <= currentSeq) throw seqUniqueError();

      seqByScope.set(channelId, proposedSeq);
      committedBatches.push(stmts);
      return Promise.all(stmts);
    }),
    __inserts: inserts,
    __updates: updates,
    __batches: batches,
    __committedBatches: committedBatches,
    __setIssuedSeq: (channelId: string, seq: number) => seqByScope.set(channelId, seq),
  };
  return db;
}

describe("createMessage — channel path", () => {
  it("bumps channel.lastMessageAt and upserts author's read-state watermark", async () => {
    const db = createCreateMessageDbMock({ messageId: "m_new" });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_author",
      content: "hello",
      channelId: "ch_1",
    });

    // Insert #1: the message itself.
    expect(db.__inserts[0].table).toBe(communityMessage);
    expect(db.__inserts[0].values.authorId).toBe("u_author");
    expect(db.__inserts[0].values.channelId).toBe("ch_1");
    // createdAt is pinned explicitly — not left to the schema $defaultFn.
    expect(typeof db.__inserts[0].values.createdAt).toBe("string");
    expect(db.__inserts[0].values.createdAt).toBe(msg.createdAt);

    // Update: bump channel lastMessageAt to the same `now`.
    expect(db.__updates[0].table).toBe(communityChannel);
    expect(db.__updates[0].set.lastMessageAt).toBe(msg.createdAt);

    // Insert #2: the author's own read-state watermark. Upsert against the
    // (userId, channelId) unique index. This is the whole point of
    // the fix — the sender's own send never surfaces as unread.
    expect(db.__inserts[1].table).toBe(communityReadState);
    expect(db.__inserts[1].values).toMatchObject({
      userId: "u_author",
      channelId: "ch_1",
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict).toBeDefined();
    expect(db.__inserts[1].onConflict.set).toMatchObject({
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict.setWhere).toBeDefined();
    // The read-state unique is now a plain unique on (userId, channelId) — no
    // partial-index targetWhere clause.
    expect(db.__inserts[1].onConflict.targetWhere).toBeUndefined();
  });

  it("timestamp alignment invariant: msg.createdAt === channel.lastMessageAt === readState.lastReadAt", async () => {
    const db = createCreateMessageDbMock();
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
    });

    const messageCreatedAt = msg.createdAt;
    const channelLastMessageAt = db.__updates[0].set.lastMessageAt;
    const readStateLastReadAt = db.__inserts[1].values.lastReadAt;
    const readStateSetLastReadAt = db.__inserts[1].onConflict.set.lastReadAt;

    // All four strings must be byte-identical. If they diverge (e.g. because
    // createdAt fell through to $defaultFn instead of the pinned `now`), the
    // inbox `lastMessageAt > lastReadAt` predicate will misfire for the sender.
    expect(channelLastMessageAt).toBe(messageCreatedAt);
    expect(readStateLastReadAt).toBe(messageCreatedAt);
    expect(readStateSetLastReadAt).toBe(messageCreatedAt);
  });

  it("second consecutive send in same channel: both upserts hit the same conflict target, second carries the newer msg id", async () => {
    // First send
    const db1 = createCreateMessageDbMock({ messageId: "m_first" });
    const first = await messageQueries.createMessage(db1, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
    });

    // Second send — different mock instance, same author + channel. Both
    // read-state upserts land on the same (userId, channelId) partial-unique
    // row in real SQLite — that is enforced by `onConflictDoUpdate` against
    // `idx_read_state_user_channel`. We assert the shape here; the D1
    // integration path enforces the uniqueness.
    const db2 = createCreateMessageDbMock({ messageId: "m_second" });
    const second = await messageQueries.createMessage(db2, {
      authorId: "u_1",
      content: "hi again",
      channelId: "ch_1",
    });

    // Both writes are upserts, not blind inserts.
    expect(db1.__inserts[1].onConflict).toBeDefined();
    expect(db2.__inserts[1].onConflict).toBeDefined();

    // Both conflict clauses share the same target columns (userId, channelId)
    // — i.e. both writes will collapse into the one row per (author, channel).
    expect(db1.__inserts[1].onConflict.target).toEqual(
      db2.__inserts[1].onConflict.target
    );
    expect(db1.__inserts[1].onConflict.target).toEqual([
      communityReadState.userId,
      communityReadState.channelId,
    ]);

    // The second send's `set` clause carries the NEWER message id — that's
    // the "watermark advances forward" contract.
    expect(db1.__inserts[1].onConflict.set.lastReadMessageId).toBe(first.id);
    expect(db2.__inserts[1].onConflict.set.lastReadMessageId).toBe(second.id);
    expect(first.id).not.toBe(second.id);
  });
});

describe("createMessage — DM path (a DM is a type=dm channel)", () => {
  it("bumps the DM channel's lastMessageAt and upserts author's read-state watermark (channelId-scoped)", async () => {
    const db = createCreateMessageDbMock({ messageId: "m_dm" });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_author",
      content: "hey",
      channelId: "dm_ch_1",
    });

    // Insert #1: the message itself, on the DM's channel.
    expect(db.__inserts[0].table).toBe(communityMessage);
    expect(db.__inserts[0].values.channelId).toBe("dm_ch_1");
    expect(db.__inserts[0].values.createdAt).toBe(msg.createdAt);

    // Update: DM channels are channels now — the lastMessageAt bump always
    // targets communityChannel.
    expect(db.__updates[0].table).toBe(communityChannel);
    expect(db.__updates[0].set.lastMessageAt).toBe(msg.createdAt);

    // Insert #2: author read-state, keyed on (userId, channelId).
    expect(db.__inserts[1].table).toBe(communityReadState);
    expect(db.__inserts[1].values).toMatchObject({
      userId: "u_author",
      channelId: "dm_ch_1",
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict.target).toEqual([
      communityReadState.userId,
      communityReadState.channelId,
    ]);
    expect(db.__inserts[1].onConflict.set).toMatchObject({
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict.setWhere).toBeDefined();
    expect(db.__inserts[1].onConflict.targetWhere).toBeUndefined();
  });

  it("timestamp alignment holds for a DM channel: msg.createdAt === channel.lastMessageAt === readState.lastReadAt", async () => {
    const db = createCreateMessageDbMock();
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "dm_ch_1",
    });
    expect(db.__updates[0].set.lastMessageAt).toBe(msg.createdAt);
    expect(db.__inserts[1].values.lastReadAt).toBe(msg.createdAt);
    expect(db.__inserts[1].onConflict.set.lastReadAt).toBe(msg.createdAt);
  });
});

describe("createMessage — seq assignment", () => {
  it("claims the seq scoped to the channelId for a channel send", async () => {
    const db = createCreateMessageDbMock();
    await messageQueries.createMessage(db, { authorId: "u_1", content: "hi", channelId: "ch_1" });
    expect(db.insert).toHaveBeenNthCalledWith(1, communityMessageSeq);
    expect(db.__inserts[0].values.seq).toBe(1);
  });

  it("claims the seq scoped to the DM's channelId for a DM send", async () => {
    const db = createCreateMessageDbMock();
    await messageQueries.createMessage(db, { authorId: "u_1", content: "hi", channelId: "dm_ch_1" });
    expect(db.__inserts[0].values).toMatchObject({ channelId: "dm_ch_1", seq: 1 });
  });

  it("passes the claimed seq through to the message row AND the read-state watermark", async () => {
    const db = createCreateMessageDbMock({ currentSeq: 4 });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
    });
    expect(msg.seq).toBe(5);
    expect(db.__inserts[0].values.seq).toBe(5);
    expect(db.__inserts[1].values.lastReadSeq).toBe(5);
    expect(db.__inserts[1].onConflict.set.lastReadSeq).toBe(5);
  });

  it("passes the claimed seq through for the DM channel read-state watermark too", async () => {
    const db = createCreateMessageDbMock({ currentSeq: 8 });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "dm_ch_1",
    });
    expect(msg.seq).toBe(9);
    expect(db.__inserts[1].values.lastReadSeq).toBe(9);
    expect(db.__inserts[1].onConflict.set.lastReadSeq).toBe(9);
  });

  it("consecutive sends in the same channel scope get strictly increasing seqs", async () => {
    const db = createCreateMessageDbMock();
    const first = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "one",
      channelId: "ch_1",
    });
    const second = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "two",
      channelId: "ch_1",
    });
    const third = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "three",
      channelId: "ch_1",
    });
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  });

  it("commits seq claim, message, channel bump, and read-state in one ordered batch", async () => {
    const db = createCreateMessageDbMock();
    await messageQueries.createMessage(db, { authorId: "u_1", content: "hi", channelId: "ch_1" });
    expect(db.__batches).toHaveLength(1);
    expect(db.__batches[0].map((stmt: MockStatement) => stmt.__kind)).toEqual([
      "seq",
      "message",
      "channel-update",
      "read-state",
    ]);
    expect(db.__committedBatches).toHaveLength(1);
  });
});

describe("createMessage — CAS claim (expectedSeq, plans/fix-agent-send-race-condition.md)", () => {
  it("expectedSeq matching the current counter succeeds and returns a row with the expected seq", async () => {
    const db = createCreateMessageDbMock({ currentSeq: 19 });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
      expectedSeq: 19,
    });
    expect(msg).not.toBeNull();
    expect(msg!.seq).toBe(20);
    expect(db.__committedBatches).toHaveLength(1);
  });

  it("stale expectedSeq rolls the atomic batch back and returns null", async () => {
    const db = createCreateMessageDbMock({
      currentSeq: 20,
      batchFailures: [{
        error: new Error("D1 batch failed", { cause: seqUniqueError() }),
      }],
    });
    const result = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
      expectedSeq: 19,
    });
    expect(result).toBeNull();
    expect(db.__batches).toHaveLength(1);
    expect(db.__committedBatches).toHaveLength(0);
  });

  it("two racers with the same expectedSeq: first wins the CAS, second loses it", async () => {
    const db = createCreateMessageDbMock({ currentSeq: 19 });
    const first = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
      expectedSeq: 19,
    });
    const second = await messageQueries.createMessage(db, {
      authorId: "u_2",
      content: "hi again",
      channelId: "ch_1",
      expectedSeq: 19,
    });
    expect(first?.seq).toBe(20);
    expect(second).toBeNull();
    expect(db.__batches).toHaveLength(2);
    expect(db.__committedBatches).toHaveLength(1);
  });

  it("expectedSeq: 0 on a scope with no prior messages succeeds (first-message-ever INSERT branch, no conflict to gate)", async () => {
    const db = createCreateMessageDbMock();
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
      expectedSeq: 0,
    });
    expect(msg).not.toBeNull();
    expect(msg!.seq).toBe(1);
  });

  it("ordinary sends retry a lost seq race using the refreshed counter", async () => {
    const db = createCreateMessageDbMock({
      batchFailures: [{ error: seqUniqueError(), issuedSeqAfter: 1 }, null],
    });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
    });
    expect(msg.seq).toBe(2);
    expect(db.__batches).toHaveLength(2);
    expect(db.__committedBatches).toHaveLength(1);
  });

  it("drains a full 30-send collision wave without exhausting ordinary retries", async () => {
    const batchFailures = Array.from({ length: 30 }, (_, index) => ({
      error: seqUniqueError(),
      issuedSeqAfter: index + 1,
    }));
    const db = createCreateMessageDbMock({ batchFailures });

    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "after the burst",
      channelId: "ch_1",
    });

    expect(msg.seq).toBe(31);
    expect(db.__batches).toHaveLength(31);
    expect(db.__committedBatches).toHaveLength(1);
  });

  it("stops an ordinary send after the bounded collision retry budget", async () => {
    const lastError = seqUniqueError();
    const batchFailures = Array.from({ length: 64 }, (_, index) => ({
      error: index === 63 ? lastError : seqUniqueError(),
      issuedSeqAfter: index + 1,
    }));
    const db = createCreateMessageDbMock({ batchFailures });

    await expect(messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "too much contention",
      channelId: "ch_1",
    })).rejects.toBe(lastError);
    expect(db.__batches).toHaveLength(64);
    expect(db.__committedBatches).toHaveLength(0);
  });

  it("recognizes a primitive D1 seq-conflict rejection", async () => {
    const db = createCreateMessageDbMock({
      batchFailures: [{
        error: "D1_ERROR: UNIQUE constraint failed: community_message.channel_id, community_message.seq",
      }],
    });

    await expect(messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "stale aligned send",
      channelId: "ch_1",
      expectedSeq: 0,
    })).resolves.toBeNull();
    expect(db.__committedBatches).toHaveLength(0);
  });

  it("does not convert an unrelated unique violation into an alignment miss", async () => {
    const nonceError = new Error(
      "D1_ERROR: UNIQUE constraint failed: community_message.author_id, community_message.client_nonce"
    );
    const db = createCreateMessageDbMock({ batchFailures: [{ error: nonceError }] });
    await expect(messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      channelId: "ch_1",
      expectedSeq: 0,
    })).rejects.toBe(nonceError);
    expect(db.__committedBatches).toHaveLength(0);
  });
});

// ── getLatestMessage / getLatestMessagesByChannelIds ──────────────────────
//
// These feed the invariant unification (plan #4) — every mark-read path that
// doesn't already know a message id calls one of these to resolve the target
// tuple. Empty target → `null` / omitted, and the mark-read path must skip.

/** Terminal-limit mock: `.limit(n)` resolves to `rows`. */
function createLimitMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("getLatestMessage", () => {
  it("channel branch: returns the row from db, orders by desc(createdAt), desc(id), limit 1", async () => {
    const db = createLimitMock([
      { id: "m_latest", createdAt: "2026-07-05T10:00:00Z" },
    ]);
    const result = await messageQueries.getLatestMessage(db, { channelId: "c_1" });
    expect(result).toEqual({ id: "m_latest", createdAt: "2026-07-05T10:00:00Z" });
    expect(db.orderBy).toHaveBeenCalledTimes(1);
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it("dm branch: same shape, scoped by the DM's channelId", async () => {
    const db = createLimitMock([
      { id: "m_dm_latest", createdAt: "2026-07-05T11:00:00Z" },
    ]);
    const result = await messageQueries.getLatestMessage(db, { channelId: "dm_ch_1" });
    expect(result).toEqual({ id: "m_dm_latest", createdAt: "2026-07-05T11:00:00Z" });
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when the target has no messages (empty channel / dm)", async () => {
    const db = createLimitMock([]);
    const cRes = await messageQueries.getLatestMessage(db, { channelId: "c_empty" });
    const dRes = await messageQueries.getLatestMessage(db, { channelId: "dm_ch_empty" });
    expect(cRes).toBeNull();
    expect(dRes).toBeNull();
  });
});

// ── listMessagesAround / listMessagesSince / getLatestMessageSeq ─────────
//
// New envelope-critical queries for the anchor-scroll refactor
// (plans/community-message-scroll-v2.md §A1). The three feed the message-list
// route's three URL modes: `?anchor`, `?since`, and the always-present
// `latestSeq` field.

/**
 * Terminal-limit mock that returns different rowsets for successive `.limit()`
 * calls. Needed because `listMessagesAround` issues two queries in parallel
 * (older + newer halves) — the caller has to look at both to compute
 * `hasMoreOlder`/`hasMoreNewer`.
 */
function createDualLimitMock(sequences: any[][]) {
  let idx = 0;
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(sequences[idx++] ?? []));
  return chain;
}

function listedRow(id: string, createdAt: string) {
  return {
    id,
    authorId: `u_${id}`,
    content: id,
    type: "default",
    mentionType: null,
    replyToId: null,
    embeds: null,
    createdAt,
    channelId: "c_1",
    authorName: `User ${id}`,
    authorEmail: `${id}@x.com`,
    authorImage: null,
  };
}

describe("listMessagesAround", () => {
  it("splits limit in half, fetches one extra probe on each side, and reports no `hasMore` when the probe rows don't come back", async () => {
    // limit=6 → olderHalf=3, newerBudget=4 (3 newer + 1 anchor). Probes:
    // older `.limit(4)`, newer `.limit(5)`. DB returns exactly the budget.
    const older = [
      listedRow("m_o3", "2026-01-01T00:00:03.000Z"),
      listedRow("m_o2", "2026-01-01T00:00:02.000Z"),
      listedRow("m_o1", "2026-01-01T00:00:01.000Z"),
    ];
    const newer = [
      listedRow("m_anchor", "2026-01-01T00:00:04.000Z"),
      listedRow("m_n1", "2026-01-01T00:00:05.000Z"),
      listedRow("m_n2", "2026-01-01T00:00:06.000Z"),
      listedRow("m_n3", "2026-01-01T00:00:07.000Z"),
    ];
    const db = createDualLimitMock([older, newer]);
    const result = await messageQueries.listMessagesAround(db, {
      channelId: "c_1",
      anchor: { createdAt: "2026-01-01T00:00:04.000Z", id: "m_anchor" },
      limit: 6,
    });
    expect(db.limit).toHaveBeenNthCalledWith(1, 4); // older half + probe
    expect(db.limit).toHaveBeenNthCalledWith(2, 5); // newer budget + probe
    expect(result.hasMoreOlder).toBe(false);
    expect(result.hasMoreNewer).toBe(false);
    expect(result.older.map((r: { id: string }) => r.id)).toEqual(["m_o3", "m_o2", "m_o1"]);
    expect(result.newer.map((r: { id: string }) => r.id)).toEqual(["m_anchor", "m_n1", "m_n2", "m_n3"]);
  });

  it("detects a full older side by seeing the probe row and trims it off", async () => {
    // olderHalf=3, DB returns 4 (probe fired) → hasMoreOlder true, only 3 rows returned.
    const older = [
      listedRow("m_o4", "2026-01-01T00:00:04.000Z"),
      listedRow("m_o3", "2026-01-01T00:00:03.000Z"),
      listedRow("m_o2", "2026-01-01T00:00:02.000Z"),
      listedRow("m_o1", "2026-01-01T00:00:01.000Z"),
    ];
    const newer = [listedRow("m_anchor", "2026-01-01T00:00:05.000Z")];
    const db = createDualLimitMock([older, newer]);
    const result = await messageQueries.listMessagesAround(db, {
      channelId: "c_1",
      anchor: { createdAt: "2026-01-01T00:00:05.000Z", id: "m_anchor" },
      limit: 6,
    });
    expect(result.hasMoreOlder).toBe(true);
    expect(result.hasMoreNewer).toBe(false);
    expect(result.older).toHaveLength(3);
  });

  it("returns an empty older side (with hasMoreOlder=false) when the anchor is at the head", async () => {
    // Anchor is the very oldest — no older rows at all.
    const older: any[] = [];
    const newer = [
      listedRow("m_anchor", "2026-01-01T00:00:01.000Z"),
      listedRow("m_n1", "2026-01-01T00:00:02.000Z"),
      listedRow("m_n2", "2026-01-01T00:00:03.000Z"),
    ];
    const db = createDualLimitMock([older, newer]);
    const result = await messageQueries.listMessagesAround(db, {
      channelId: "c_1",
      anchor: { createdAt: "2026-01-01T00:00:01.000Z", id: "m_anchor" },
      limit: 6,
    });
    expect(result.hasMoreOlder).toBe(false);
    expect(result.older).toEqual([]);
    expect(result.newer[0]?.id).toBe("m_anchor");
  });

  it("accepts a DM channel scope", async () => {
    const db = createDualLimitMock([[], [listedRow("m_anchor", "2026-01-01T00:00:01.000Z")]]);
    const result = await messageQueries.listMessagesAround(db, {
      channelId: "dm_ch_1",
      anchor: { createdAt: "2026-01-01T00:00:01.000Z", id: "m_anchor" },
      limit: 6,
    });
    expect(result.newer[0]?.id).toBe("m_anchor");
  });
});

describe("listMessagesSince", () => {
  it("returns rows in ASC order, trimmed to `limit`, with the probe row driving hasMore in the caller", async () => {
    // Query fetches `limit + 1` — caller (route) trims. The query itself
    // returns whatever the DB gives; test that the passed limit is `limit+1`.
    const rows = [
      listedRow("m_1", "2026-01-01T00:00:01.000Z"),
      listedRow("m_2", "2026-01-01T00:00:02.000Z"),
      listedRow("m_3", "2026-01-01T00:00:03.000Z"),
    ];
    const db = createDualLimitMock([rows]);
    const result = await messageQueries.listMessagesSince(db, {
      channelId: "c_1",
      since: { createdAt: "2026-01-01T00:00:00.000Z", id: "m_0" },
      limit: 50,
    });
    expect(db.limit).toHaveBeenCalledWith(51);
    expect(result.map((r: { id: string }) => r.id)).toEqual(["m_1", "m_2", "m_3"]);
  });

  it("returns empty when no rows are newer than `since`", async () => {
    const db = createDualLimitMock([[]]);
    const result = await messageQueries.listMessagesSince(db, {
      channelId: "c_1",
      since: { createdAt: "2026-01-01T00:00:00.000Z", id: "m_0" },
    });
    expect(result).toEqual([]);
  });

  it("accepts a DM channel scope", async () => {
    const db = createDualLimitMock([[listedRow("m_1", "2026-01-01T00:00:01.000Z")]]);
    const result = await messageQueries.listMessagesSince(db, {
      channelId: "dm_ch_1",
      since: { createdAt: "2026-01-01T00:00:00.000Z", id: "m_0" },
    });
    expect(result).toHaveLength(1);
  });
});

describe("getLatestMessageSeq", () => {
  function createSeqMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }
  it("returns 0 when the scope is empty (MAX() over 0 rows yields NULL)", async () => {
    const db = createSeqMock([{ maxSeq: null }]);
    const result = await messageQueries.getLatestMessageSeq(db, { channelId: "c_empty" });
    expect(result).toBe(0);
  });

  it("returns the MAX(seq) value for a non-empty scope", async () => {
    const db = createSeqMock([{ maxSeq: 42 }]);
    const result = await messageQueries.getLatestMessageSeq(db, { channelId: "c_1" });
    expect(result).toBe(42);
  });

  it("also accepts a DM channel scope", async () => {
    const db = createSeqMock([{ maxSeq: 7 }]);
    const result = await messageQueries.getLatestMessageSeq(db, { channelId: "dm_ch_1" });
    expect(result).toBe(7);
  });

  it("returns 0 when the driver returns an empty rowset", async () => {
    // Defensive: some D1 aggregate paths may return `[]` rather than `[{ maxSeq: null }]`.
    const db = createSeqMock([]);
    const result = await messageQueries.getLatestMessageSeq(db, { channelId: "c_1" });
    expect(result).toBe(0);
  });
});

describe("getLatestMessagesByChannelIds", () => {
  function createInnerJoinMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.groupBy = vi.fn(() => chain);
    chain.as = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns [] and does not touch db when channelIds is empty", async () => {
    const db = createInnerJoinMock([{ channelId: "c_a", id: "m_a", createdAt: "x" }]);
    const result = await messageQueries.getLatestMessagesByChannelIds(db, []);
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns one row per non-empty channel, omits empty channels", async () => {
    // The join returns rows for c_a and c_b only — c_empty was in the input
    // but had no message rows and thus never appears in the join output.
    const db = createInnerJoinMock([
      { channelId: "c_a", id: "m_a_latest", createdAt: "2026-07-05T10:00:00Z" },
      { channelId: "c_b", id: "m_b_latest", createdAt: "2026-07-05T11:00:00Z" },
    ]);
    const result = await messageQueries.getLatestMessagesByChannelIds(db, [
      "c_a",
      "c_b",
      "c_empty",
    ]);
    // Result covers only channels with messages. c_empty is silently dropped
    // — the invariant contract for the mass mark-read path.
    expect(result).toHaveLength(2);
    const byChannel = Object.fromEntries(result.map((r) => [r.channelId, r]));
    expect(byChannel["c_a"]).toEqual({
      channelId: "c_a",
      id: "m_a_latest",
      createdAt: "2026-07-05T10:00:00Z",
    });
    expect(byChannel["c_b"]).toEqual({
      channelId: "c_b",
      id: "m_b_latest",
      createdAt: "2026-07-05T11:00:00Z",
    });
    expect(byChannel["c_empty"]).toBeUndefined();
  });

  it("deduplicates when two messages in the same channel share an exact createdAt (picks the greater id)", async () => {
    // Milliseconds collision within a single channel — the raw join produces
    // both rows, our helper collapses them.
    const db = createInnerJoinMock([
      { channelId: "c_a", id: "m_a_002", createdAt: "2026-07-05T10:00:00Z" },
      { channelId: "c_a", id: "m_a_001", createdAt: "2026-07-05T10:00:00Z" },
    ]);
    const result = await messageQueries.getLatestMessagesByChannelIds(db, ["c_a"]);
    expect(result).toHaveLength(1);
    // desc(createdAt), desc(id) — greater id wins on a tie.
    expect(result[0]!.id).toBe("m_a_002");
  });
});

// ── Property test: the invariant, end-to-end ──────────────────────────────
//
// The safety net: spin every mark-read write path through a minimal in-memory
// db mock and assert that EVERY row it wants to write satisfies
//   lastReadAt === message.createdAt AND lastReadMessageId === message.id.
//
// This is the single test that will catch a future PR that reintroduces
// `{ lastReadAt: now, lastReadMessageId: null }`.

describe("read-state invariant property — every write path", () => {
  // Fixture message tuples used across paths.
  const CHANNEL_MSG = { id: "m_ch_latest", createdAt: "2026-07-05T10:00:00.000Z", seq: 10 };
  const DM_MSG = { id: "m_dm_latest", createdAt: "2026-07-05T11:00:00.000Z", seq: 11 };

  // Capture every insert/onConflict/update `set` payload that touches
  // communityReadState.
  type Capture = {
    lastReadAt?: string | null;
    lastReadMessageId?: string | null;
  };
  const writes: Capture[] = [];

  function makePropertyDb() {
    let seqCounter = 0;
    const db: any = {
      insert: vi.fn((table: unknown) => {
        const insert: any = {
          values: vi.fn((v: any) => {
          if (table === communityMessageSeq) {
            // `claimNextSeq`'s counter row — not a read-state write, doesn't
            // carry lastReadAt/lastReadMessageId, so it's a no-op for `writes`.
            return {
              onConflictDoUpdate: vi.fn(() => ({
                returning: vi.fn(() => Promise.resolve([{ nextSeq: ++seqCounter }])),
              })),
            };
          }
          if (Array.isArray(v)) {
            for (const row of v) writes.push({
              lastReadAt: row.lastReadAt,
              lastReadMessageId: row.lastReadMessageId,
            });
          } else {
            writes.push({ lastReadAt: v.lastReadAt, lastReadMessageId: v.lastReadMessageId });
          }
          const chain: any = {};
          chain.returning = vi.fn(() =>
            Promise.resolve([{ ...v, id: v.id ?? "m_generated", revision: 1 }])
          );
          chain.onConflictDoUpdate = vi.fn((cfg: any) => {
              writes.push({
                lastReadAt: cfg.set.lastReadAt,
                lastReadMessageId: cfg.set.lastReadMessageId,
              });
              return chain;
            });
            return chain;
          }),
          select: vi.fn(() => {
            const chain: any = {};
            chain.onConflictDoUpdate = vi.fn(() => chain);
            chain.returning = vi.fn(() => Promise.resolve([]));
            return chain;
          }),
        };
        return insert;
      }),
      update: vi.fn(() => ({
        set: vi.fn((s: any) => {
          writes.push({ lastReadAt: s.lastReadAt, lastReadMessageId: s.lastReadMessageId });
          return { where: vi.fn(() => Promise.resolve()) };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
      select: vi.fn(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.innerJoin = vi.fn(() => chain);
        chain.groupBy = vi.fn(() => chain);
        chain.as = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve([]));
        chain.where = vi.fn(() => chain);
        chain.then = (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve([]).then(resolve);
        return chain;
      }),
      // `createMessage` composes (insert msg, update scope) into a single
      // `db.batch(...)` — insert/update chains above already resolve to
      // Promises, so await each and collect per-statement results.
      batch: vi.fn(async (stmts: unknown[]) => Promise.all(stmts as Promise<unknown>[])),
    };
    return db;
  }

  it("every mark-read write path only ever produces aligned (lastReadAt, lastReadMessageId) tuples", async () => {
    writes.length = 0;
    const readState = await import("../../src/db/queries/community/read-state");
    const msg = await import("../../src/db/queries/community/message");

    // Path A: markReadToMessageBuilder — channel
    const dbA = makePropertyDb();
    readState.markReadToMessageBuilder(dbA, {
      userId: "u_1",
      channelId: "c_1",
      message: CHANNEL_MSG,
    });

    // Path B: markReadToMessageBuilder — DM channel (a DM is a type=dm channel)
    const dbB = makePropertyDb();
    readState.markReadToMessageBuilder(dbB, {
      userId: "u_1",
      channelId: "dm_ch_1",
      message: DM_MSG,
    });

    // Path C: markReadToMessage (async sibling)
    const dbC = makePropertyDb();
    await readState.markReadToMessage(dbC, {
      userId: "u_1",
      channelId: "c_2",
      message: CHANNEL_MSG,
    });

    // Path D: createMessage — channel branch (author read-watermark upsert)
    const dbD = makePropertyDb();
    await msg.createMessage(dbD, {
      authorId: "u_1",
      content: "hi",
      channelId: "c_new",
    });

    // Path E: createMessage — DM channel branch (author read-watermark upsert)
    const dbE = makePropertyDb();
    await msg.createMessage(dbE, {
      authorId: "u_1",
      content: "hi",
      channelId: "dm_ch_new",
    });

    // Path F: markAllServerChannelsRead — one channel with a latest message,
    // no existing row → insert path. The visible-channel id set is passed as an
    // argument now, so the only select this issues is the existing-read-state
    // lookup (returns empty → insert path).
    const dbF: any = makePropertyDb();
    dbF.select = vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.groupBy = vi.fn(() => chain);
      chain.as = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve([]));
      chain.where = vi.fn(() => chain);
      chain.then = (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve([]).then(resolve);
      return chain;
    });
    const spy = vi
      .spyOn(msg, "getLatestMessagesByChannelIds")
      .mockResolvedValue([
        { channelId: "c_mass", id: "m_mass_latest", createdAt: "2026-07-06T00:00:00.000Z", seq: 12 },
      ]);
    await readState.markAllServerChannelsRead(dbF, "u_1", ["c_mass"]);
    spy.mockRestore();

    // The invariant assertion: every captured write must have BOTH fields
    // set AND the timestamp aligned to a real message.createdAt string. The
    // fixture messages are the only source of message tuples, so every
    // aligned pair must match one of them.
    expect(writes.length).toBeGreaterThan(0);
    const validPairs = new Set([
      `${CHANNEL_MSG.createdAt}|${CHANNEL_MSG.id}`,
      `${DM_MSG.createdAt}|${DM_MSG.id}`,
      `2026-07-06T00:00:00.000Z|m_mass_latest`,
      // createMessage generates its own `now` and `msg.id` — capture those
      // by scanning the inserts on dbD and dbE for the message row.
    ]);
    // Add createMessage-derived valid pairs. `createMessage` now issues an
    // `insert` for the seq counter (`communityMessageSeq`) BEFORE the message
    // row, so scan every insert call on dbD/dbE for the one whose payload is
    // the message row (identified by carrying `content`) rather than
    // assuming it's the first call.
    const createDbs: any[] = [dbD, dbE];
    for (const cdb of createDbs) {
      for (const result of cdb.insert.mock.results as Array<{ value: any }>) {
        const valuesCall = result.value?.values?.mock?.calls?.[0]?.[0];
        if (!valuesCall || !("content" in valuesCall)) continue;
        const id = valuesCall.id ?? "m_generated";
        const createdAt = valuesCall.createdAt;
        validPairs.add(`${createdAt}|${id}`);
      }
    }

    for (const w of writes) {
      // The invariant: never write a null lastReadMessageId, and never a
      // dangling lastReadAt. NOTE: `writes` also captures INSERT `values`
      // payloads, which for the message row itself have neither field —
      // those slip through this filter naturally by having both undefined.
      // Only assert on writes that actually name a read-state column.
      const hasLastReadAt = w.lastReadAt !== undefined;
      const hasLastReadMessageId = w.lastReadMessageId !== undefined;
      if (!hasLastReadAt && !hasLastReadMessageId) continue;
      expect(w.lastReadMessageId, `invariant violated — null lastReadMessageId in ${JSON.stringify(w)}`).not.toBeNull();
      expect(typeof w.lastReadAt).toBe("string");
      expect(typeof w.lastReadMessageId).toBe("string");
      const key = `${w.lastReadAt}|${w.lastReadMessageId}`;
      expect(
        validPairs.has(key),
        `invariant violated — write ${key} is not aligned to any message tuple`
      ).toBe(true);
    }
  });
});
