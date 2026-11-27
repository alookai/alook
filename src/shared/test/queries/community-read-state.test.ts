import { describe, it, expect, vi } from "vitest";
import * as readStateQueries from "../../src/db/queries/community/read-state";
import { communityChannel, communityMessage, communityReadState } from "../../src/db/community-schema";
import { user } from "../../src/db/schema";
import { createMigratedDb } from "../helpers/migrated-db";

// `markReadToMessageBuilder` is the canonical channel/DM read-state upsert
// under the invariant unification (plan #4). It's used both stand-alone (DM
// / thread routes via the `markReadToMessage` sibling) and inside
// `db.batch([...])` on the channel read route. These tests pin the shape and
// the invariant — actual SQL behaviour is exercised in D1 integration runs.

function createInsertBuilderMock() {
  const chain: any = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  // Sentinel returned instead of a Promise — mimics Drizzle's builder shape.
  chain.onConflictDoUpdate = vi.fn(() => ({ __builder: "insert-onconflict" }));
  return chain;
}

describe("markReadToMessageWithRevision", () => {
  it("batches one exact canonical message boundary with its account revision", async () => {
    const db = makeMassMarkDbMock(12);
    const message = {
      id: "getting-ready",
      channelId: "public-1",
      createdAt: "2026-09-07T06:00:00.000Z",
      seq: 4,
    };

    await expect(readStateQueries.markReadToMessageWithRevision(db, {
      userId: "owner-1",
      channelId: "public-1",
      message,
    })).resolves.toEqual({ count: 1, changed: true, revision: 12 });

    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.batch.mock.calls[0]![0]).toHaveLength(3);
  });
});

describe("getAccountReadStateSnapshot", () => {
  it("keeps revision and rows aligned when a mutation races the snapshot", async () => {
    const builders = [
      { kind: "revision" },
      { kind: "rows" },
    ];
    let selectIndex = 0;
    let state = {
      revision: 4,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m2",
        lastReadAt: "2026-08-24T00:00:02.000Z",
        lastReadSeq: 2,
      }],
    };
    const db: any = {
      select: vi.fn(() => {
        const builder: any = builders[selectIndex++];
        builder.from = vi.fn(() => builder);
        builder.where = vi.fn(() => builder);
        builder.limit = vi.fn(() => builder);
        return builder;
      }),
      batch: vi.fn(async () => {
        const captured = structuredClone(state);
        state = {
          revision: 5,
          readStates: [{
            channelId: "c1",
            lastReadMessageId: "m3",
            lastReadAt: "2026-08-24T00:00:03.000Z",
          lastReadSeq: 3,
        }],
        };
        return [
          [{ revision: captured.revision }],
          captured.readStates,
        ];
      }),
    };

    await expect(readStateQueries.getAccountReadStateSnapshot(db, "u1")).resolves.toEqual({
      revision: 4,
      readStates: [{
        channelId: "c1",
        lastReadMessageId: "m2",
        lastReadAt: "2026-08-24T00:00:02.000Z",
        lastReadSeq: 2,
      }],
    });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(db.batch.mock.calls[0]![0]).toEqual(builders);
  });
});

it("persists scoped read cursors and revisions on the migrated schema", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    const userId = "reader";
    const channelId = "channel-a";
    const channelB = "channel-b";
    const first = { id: "first", channelId, createdAt: "2026-09-07T06:00:00Z", seq: 2 };
    const latest = { id: "latest", channelId, createdAt: "2026-09-07T06:01:00Z", seq: 7 };
    const other = { id: "other", channelId: channelB, createdAt: first.createdAt, seq: 3 };
    await db.insert(user).values([
      { id: userId, email: "reader@example.test", name: "Reader" },
      { id: "neighbor", email: "neighbor@example.test", name: "Neighbor" },
    ]).run();
    await db.insert(communityChannel).values([channelId, channelB, "empty", "neighbor-channel"].map(id => ({ id, type: "text" }))).run();
    await db.insert(communityMessage).values([first, latest, other].map(message => ({ ...message, authorId: "neighbor" }))).run();
    await db.insert(communityReadState).values({
      userId: "neighbor", channelId: "neighbor-channel", lastReadAt: first.createdAt, lastReadSeq: 0,
    }).run();

    await expect(readStateQueries.markReadToMessageWithRevision(db, {
      userId, channelId, message: { ...first, id: "missing" },
    })).resolves.toEqual({ count: 0, changed: false, revision: 0 });
    await expect(readStateQueries.getAccountReadStateSnapshot(db, userId)).resolves.toEqual({ revision: 0, readStates: [] });
    const markFirst = () => readStateQueries.markReadToMessageWithRevision(db, { userId, channelId, message: first });
    await expect(markFirst()).resolves.toEqual({ count: 1, changed: true, revision: 1 });
    await expect(markFirst()).resolves.toEqual({ count: 0, changed: false, revision: 1 });

    const markAll = () => readStateQueries.markAllServerChannelsRead(db, userId, [channelId, channelB, "empty"]);
    await expect(markAll()).resolves.toEqual({ count: 2, changed: true, revision: 2 });
    await expect(markAll()).resolves.toEqual({ count: 2, changed: false, revision: 2 });

    const next = { ...other, id: "next", seq: 4 };
    await db.insert(communityMessage).values({ ...next, authorId: "neighbor" }).run();
    const expectedCursor = { id: next.id, createdAt: next.createdAt, seq: next.seq };
    await expect(readStateQueries.bumpReadCursor(db, userId, { channelId: channelB }, next.seq)).resolves.toEqual(expectedCursor);
    await expect(readStateQueries.bumpReadCursor(db, userId, { channelId: channelB }, other.seq)).resolves.toEqual(expectedCursor);
    const account = await readStateQueries.getAccountReadStateSnapshot(db, userId);
    expect(account.revision).toBe(2);
    expect(account.readStates.toSorted((a, b) => a.channelId.localeCompare(b.channelId))).toEqual([
      { channelId, lastReadMessageId: latest.id, lastReadAt: latest.createdAt, lastReadSeq: latest.seq },
      { channelId: channelB, lastReadMessageId: next.id, lastReadAt: next.createdAt, lastReadSeq: next.seq },
    ]);
  } finally {
    sqlite.close();
  }
});

it("marks 600 channels read in bounded set-based statements while skipping already-read channels", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    const userId = "reader_mass";
    await db.insert(user).values([
      { id: userId, email: "reader-mass@example.test", name: "ReaderMass" },
      { id: "sender_mass", email: "sender-mass@example.test", name: "SenderMass" },
    ]).run();

    const totalChannels = 600;
    const channelIds = Array.from({ length: totalChannels }, (_, i) => `mass_ch_${String(i).padStart(3, "0")}`);
    sqlite.transaction(() => {
      const insertCh = sqlite.prepare("INSERT INTO community_channel (id, type, created_at) VALUES (?, 'text', '2026-09-01T00:00:00Z')");
      const insertMsg = sqlite.prepare("INSERT INTO community_message (id, author_id, channel_id, seq, content, created_at) VALUES (?, 'sender_mass', ?, ?, 'hi', ?)");
      const insertRs = sqlite.prepare("INSERT INTO community_read_state (id, user_id, channel_id, last_read_message_id, last_read_at, last_read_seq) VALUES (?, ?, ?, ?, ?, ?)");
      for (let i = 0; i < totalChannels; i++) {
        const chId = channelIds[i]!;
        insertCh.run(chId);
        const msgId = `msg_${i}`;
        const ts = `2026-09-07T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
        insertMsg.run(msgId, chId, 5, ts);
        // First 550 channels are already read at seq 5; last 50 are unread.
        if (i < 550) {
          insertRs.run(`rs_${i}`, userId, chId, msgId, ts, 5);
        }
      }
    })();

    const batchSpy = vi.spyOn(db, "batch");
    const first = await readStateQueries.markAllServerChannelsRead(db, userId, channelIds);
    expect(first).toEqual({ count: 600, changed: true, revision: 1 });
    expect(batchSpy).toHaveBeenCalledTimes(1);
    // 600 targets chunked at 250 = 3 set-based INSERT..SELECT statements + 2 revision statements = 5 total.
    expect(batchSpy.mock.calls[0]![0]).toHaveLength(5);

    const storedCount = (sqlite.prepare("SELECT COUNT(*) AS cnt FROM community_read_state WHERE user_id = ? AND last_read_seq = 5").get(userId) as { cnt: number }).cnt;
    expect(storedCount).toBe(600);

    // Re-running when all 600 channels are already read produces changed: false and leaves revision untouched.
    const second = await readStateQueries.markAllServerChannelsRead(db, userId, channelIds);
    expect(second).toEqual({ count: 600, changed: false, revision: 1 });
  } finally {
    sqlite.close();
  }
});

describe("markReadToMessageBuilder — channel branch", () => {
  it("returns a builder synchronously (no await, no Promise) so it composes into db.batch", () => {
    const db = createInsertBuilderMock();
    const result = readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      message: { id: "m_42", createdAt: "2026-07-03T00:00:00Z", seq: 42 },
    });
    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.values).toHaveBeenCalledTimes(1);
    expect(db.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("aligns lastReadAt to message.createdAt AND lastReadMessageId to message.id in both values and set clauses", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      message: { id: "m_42", createdAt: "2026-07-03T00:00:00Z", seq: 42 },
    });
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({
      userId: "u_1",
      channelId: "c_1",
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
      // ref/id seq unification: humans now store lastReadSeq too, or the seq
      // unread predicate never sees a human's read.
      lastReadSeq: 42,
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set).toMatchObject({
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
      lastReadSeq: 42,
    });
  });

  it("targets the (userId, channelId) unique index — a plain unique, no targetWhere", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      message: { id: "m_1", createdAt: "2026-01-01T00:00:00Z", seq: 1 },
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.target).toEqual([
      communityReadState.userId,
      communityReadState.channelId,
    ]);
    // The read-state unique is now a plain unique on (userId, channelId) — no
    // partial-index targetWhere clause.
    expect(conflictArg.targetWhere).toBeUndefined();
  });
});

describe("markReadToMessageBuilder — DM is a channel", () => {
  // DMs are type=dm channels now: `markReadToMessageBuilder` takes `{ channelId }`
  // only. A DM read-state write goes down the exact same channelId path — there
  // is no separate dm branch, no dmConversationId column, and no both/neither
  // validation to throw on. The old "targets the dm partial-unique index",
  // "throws when neither", and "throws when both" cases are deleted: they tested
  // a dm-vs-channel split that no longer exists.
  it("a DM channel read-state write uses the same (userId, channelId) upsert", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "dm_ch_1",
      message: { id: "m_9", createdAt: "2026-07-04T00:00:00Z", seq: 9 },
    });
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({
      userId: "u_1",
      channelId: "dm_ch_1",
      lastReadAt: "2026-07-04T00:00:00Z",
      lastReadMessageId: "m_9",
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.target).toEqual([
      communityReadState.userId,
      communityReadState.channelId,
    ]);
    expect(conflictArg.set).toMatchObject({
      lastReadAt: "2026-07-04T00:00:00Z",
      lastReadMessageId: "m_9",
    });
    expect(conflictArg.setWhere).toBeDefined();
  });
});

// ── markAllServerChannelsRead ─────────────────────────────────────────────
//
// The mass mark-read path is the most invariant-critical write on the file:
// pre-refactor it would insert `lastReadMessageId = null` rows on every
// channel it touched. Post-refactor it must (a) skip empty channels, (b)
// align every row it writes to that channel's latest message, and (c)
// return the count of channels that got a write (not the reachable-channel
// count).

function makeMassMarkDbMock(revision = 7) {
  const inserts: any[] = [];
  const conflicts: any[] = [];
  const deletes: any[] = [];
  const db: any = {
    insert: vi.fn(() => {
      const chain: any = {};
      chain.values = vi.fn((value: any) => {
        inserts.push(value);
        return chain;
      });
      chain.onConflictDoUpdate = vi.fn((value: any) => {
        conflicts.push(value);
        return chain;
      });
      chain.select = vi.fn(() => chain);
      chain.returning = vi.fn(() => chain);
      return chain;
    }),
    select: vi.fn(() => {
      const chain: any = { __snapshot: true };
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.then = (resolve: (value: unknown) => unknown) => resolve([{ revision }]);
      return chain;
    }),
    delete: vi.fn((table: unknown) => {
      const chain: any = { __delete: table };
      chain.where = vi.fn((condition: unknown) => {
        deletes.push({ table, condition });
        return chain;
      });
      return chain;
    }),
    batch: vi.fn(async (statements: any[]) => statements.map((_statement, index) => {
      if (index === 0) return [{ revision }];
      if (index === statements.length - 1) return [{ revision }];
      return [];
    })),
    __inserts: inserts,
    __conflicts: conflicts,
    __deletes: deletes,
  };
  return db;
}

describe("markAllServerChannelsRead", () => {
  it("returns 0 and does nothing when the user has no member channels", async () => {
    const db = makeMassMarkDbMock();
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([]);

    const result = await readStateQueries.markAllServerChannelsRead(db, "u_1", []);
    expect(result).toEqual({ count: 0, changed: false, revision: 7 });
    expect(db.__inserts).toHaveLength(0);
    expect(db.batch).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 0 and skips writes when NONE of the member channels have messages", async () => {
    const db = makeMassMarkDbMock();
    const messageModule = await import("../../src/db/queries/community/message");
    // Every channel is empty — the batched helper returns nothing.
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([]);

    const result = await readStateQueries.markAllServerChannelsRead(db, "u_1", ["c_a", "c_b"]);
    expect(result).toEqual({ count: 0, changed: false, revision: 7 });
    expect(db.__inserts).toHaveLength(0);
    expect(db.batch).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns the count of non-empty channels; batches set-based read-state upserts in a single statement", async () => {
    const db = makeMassMarkDbMock(11);
    const messageModule = await import("../../src/db/queries/community/message");
    // c_a and c_b have messages; c_c_empty has none.
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([
      { channelId: "c_a", id: "m_a_latest", createdAt: "2026-07-05T10:00:00Z", seq: 10 },
      { channelId: "c_b", id: "m_b_latest", createdAt: "2026-07-05T11:00:00Z", seq: 11 },
    ]);

    const result = await readStateQueries.markAllServerChannelsRead(db, "u_1", ["c_a", "c_b", "c_c_empty"]);
    expect(result).toEqual({
      count: 2,
      changed: true,
      revision: 11,
    });
    expect(db.batch).toHaveBeenCalledTimes(1);
    // [advanceRevisionWhenChanged, setBasedInsertSelect, readRevision]
    expect(db.batch.mock.calls[0]![0]).toHaveLength(3);
    expect(db.__deletes).toHaveLength(0);
    spy.mockRestore();
  });

  it("uses the same guarded set-based upsert for existing rows and fresh rows", async () => {
    const db = makeMassMarkDbMock();
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([
      { channelId: "c_a", id: "m_a_new", createdAt: "2026-07-05T10:00:00Z", seq: 20 },
      { channelId: "c_b", id: "m_b_new", createdAt: "2026-07-05T11:00:00Z", seq: 21 },
    ]);

    const result = await readStateQueries.markAllServerChannelsRead(db, "u_1", ["c_a", "c_b"]);
    expect(result).toMatchObject({ count: 2, changed: true, revision: 7 });
    expect(db.__conflicts[0]).toMatchObject({
      target: [communityReadState.userId, communityReadState.channelId],
    });
    expect(db.__conflicts[0]!.setWhere).toBeDefined();
    spy.mockRestore();
  });

  it("returns the current revision when the account has no DMs", async () => {
    const db = makeMassMarkDbMock(13);
    const dmModule = await import("../../src/db/queries/community/dm");
    const spy = vi.spyOn(dmModule, "listDMs").mockResolvedValue([]);

    await expect(readStateQueries.markAllDmsRead(db, "u_1")).resolves.toEqual({
      count: 0,
      changed: false,
      revision: 13,
    });
    spy.mockRestore();
  });
});
