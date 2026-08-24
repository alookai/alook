import { describe, it, expect, vi } from "vitest";
import * as readStateQueries from "../../src/db/queries/community/read-state";
import { communityReadState } from "../../src/db/community-schema";

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

describe("community/read-state exports", () => {
  it("exports markReadToMessageBuilder + markReadToMessage", () => {
    expect(typeof readStateQueries.markReadToMessageBuilder).toBe("function");
    expect(typeof readStateQueries.markReadToMessage).toBe("function");
  });
  it("exports markAllServerChannelsRead", () => {
    expect(typeof readStateQueries.markAllServerChannelsRead).toBe("function");
  });
});

describe("getAccountReadStateSnapshot", () => {
  it("keeps revision and rows aligned when a mutation races the snapshot", async () => {
    const builders = [{ kind: "revision" }, { kind: "rows" }];
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
        return [[{ revision: captured.revision }], captured.readStates];
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
    // The invariant: values and set carry the same aligned tuple.
    expect(valuesArg.lastReadAt).toBe(valuesArg.lastReadMessageId ? "2026-07-03T00:00:00Z" : undefined);
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

  it("includes a monotone setWhere so stale-createdAt PUTs cannot regress the pointer", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      message: { id: "m_42", createdAt: "2026-07-03T00:00:00Z", seq: 42 },
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    // The setWhere is a Drizzle SQL fragment; we can't easily assert its
    // exact structure without evaluating it, but its mere presence is
    // the load-bearing invariant here — its absence would silently
    // reintroduce the "channel switch → return → stale mid-viewport row
    // overwrites the newer pointer" bug.
    expect(conflictArg.setWhere).toBeDefined();
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
      chain.returning = vi.fn(() => chain);
      return chain;
    }),
    batch: vi.fn(async (statements: unknown[]) =>
      statements.map((_, index) => index === statements.length - 1 ? [{ revision }] : [])
    ),
    __inserts: inserts,
    __conflicts: conflicts,
  };
  return db;
}

describe("markAllServerChannelsRead", () => {
  it("returns 0 and does nothing when the user has no member channels", async () => {
    const db = makeMassMarkDbMock();
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([]);

    const result = await readStateQueries.markAllServerChannelsRead(db, "u_1", []);
    expect(result).toEqual({ count: 0, revision: null, advances: [] });
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
    expect(result).toEqual({ count: 0, revision: null, advances: [] });
    expect(db.__inserts).toHaveLength(0);
    expect(db.batch).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns the count of non-empty channels; inserts aligned rows for channels with no existing read state", async () => {
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
      revision: 11,
      advances: [{
        channelId: "c_a",
        lastReadMessageId: "m_a_latest",
        lastReadAt: "2026-07-05T10:00:00Z",
        lastReadSeq: 10,
      }, {
        channelId: "c_b",
        lastReadMessageId: "m_b_latest",
        lastReadAt: "2026-07-05T11:00:00Z",
        lastReadSeq: 11,
      }],
    });
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.batch.mock.calls[0]![0]).toHaveLength(3);
    const rows = db.__inserts.filter((row: any) => row.channelId);
    expect(rows).toHaveLength(2);
    // The invariant per-row: lastReadAt === message.createdAt, lastReadMessageId === message.id.
    const byChannel = Object.fromEntries(rows.map((r) => [r.channelId, r]));
    expect(byChannel["c_a"]).toMatchObject({
      userId: "u_1",
      channelId: "c_a",
      lastReadAt: "2026-07-05T10:00:00Z",
      lastReadMessageId: "m_a_latest",
      lastReadSeq: 10,
    });
    expect(byChannel["c_b"]).toMatchObject({
      userId: "u_1",
      channelId: "c_b",
      lastReadAt: "2026-07-05T11:00:00Z",
      lastReadMessageId: "m_b_latest",
      lastReadSeq: 11,
    });
    spy.mockRestore();
  });

  it("uses the same guarded upsert for existing rows and fresh rows", async () => {
    const db = makeMassMarkDbMock();
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([
      { channelId: "c_a", id: "m_a_new", createdAt: "2026-07-05T10:00:00Z", seq: 20 },
      { channelId: "c_b", id: "m_b_new", createdAt: "2026-07-05T11:00:00Z", seq: 21 },
    ]);

    const result = await readStateQueries.markAllServerChannelsRead(db, "u_1", ["c_a", "c_b"]);
    expect(result).toMatchObject({ count: 2, revision: 7 });
    const sets = db.__conflicts.slice(0, 2).map((conflict: any) => conflict.set);
    const aTuple = sets.find((s) => s.lastReadMessageId === "m_a_new");
    const bTuple = sets.find((s) => s.lastReadMessageId === "m_b_new");
    expect(aTuple).toBeDefined();
    expect(bTuple).toBeDefined();
    expect(aTuple!.lastReadAt).toBe("2026-07-05T10:00:00Z");
    expect(bTuple!.lastReadAt).toBe("2026-07-05T11:00:00Z");
    expect(aTuple!.lastReadSeq).toBe(20);
    expect(bTuple!.lastReadSeq).toBe(21);
    spy.mockRestore();
  });

  it("each upsert carries a seq monotone guard", async () => {
    const db = makeMassMarkDbMock();
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([
      { channelId: "c_a", id: "m_a_new", createdAt: "2026-07-05T10:00:00Z", seq: 20 },
    ]);

    await readStateQueries.markAllServerChannelsRead(db, "u_1", ["c_a"]);
    expect(db.__conflicts[0].setWhere).toBeDefined();
    expect(db.batch).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
