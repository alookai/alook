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

describe("markReadToMessageBuilder — channel branch", () => {
  it("returns a builder synchronously (no await, no Promise) so it composes into db.batch", () => {
    const db = createInsertBuilderMock();
    const result = readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      message: { id: "m_42", createdAt: "2026-07-03T00:00:00Z" },
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
      message: { id: "m_42", createdAt: "2026-07-03T00:00:00Z" },
    });
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({
      userId: "u_1",
      channelId: "c_1",
      dmConversationId: null,
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
    });
    // The invariant: values and set carry the same aligned tuple.
    expect(valuesArg.lastReadAt).toBe(valuesArg.lastReadMessageId ? "2026-07-03T00:00:00Z" : undefined);
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set).toMatchObject({
      lastReadAt: "2026-07-03T00:00:00Z",
      lastReadMessageId: "m_42",
    });
  });

  it("targets the channel partial-unique index (idx_read_state_user_channel)", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      channelId: "c_1",
      message: { id: "m_1", createdAt: "2026-01-01T00:00:00Z" },
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.target).toEqual([
      communityReadState.userId,
      communityReadState.channelId,
    ]);
    expect(conflictArg.targetWhere).toBeDefined();
  });
});

describe("markReadToMessageBuilder — dm branch", () => {
  it("targets the dm partial-unique index and writes dmConversationId, channelId=null", () => {
    const db = createInsertBuilderMock();
    readStateQueries.markReadToMessageBuilder(db, {
      userId: "u_1",
      dmConversationId: "dm_1",
      message: { id: "m_9", createdAt: "2026-07-04T00:00:00Z" },
    });
    const valuesArg = db.values.mock.calls[0][0];
    expect(valuesArg).toMatchObject({
      userId: "u_1",
      channelId: null,
      dmConversationId: "dm_1",
      lastReadAt: "2026-07-04T00:00:00Z",
      lastReadMessageId: "m_9",
    });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.target).toEqual([
      communityReadState.userId,
      communityReadState.dmConversationId,
    ]);
    expect(conflictArg.set).toMatchObject({
      lastReadAt: "2026-07-04T00:00:00Z",
      lastReadMessageId: "m_9",
    });
  });

  it("throws when neither channelId nor dmConversationId is provided", () => {
    const db = createInsertBuilderMock();
    expect(() =>
      readStateQueries.markReadToMessageBuilder(db, {
        userId: "u_1",
        message: { id: "m_9", createdAt: "2026-07-04T00:00:00Z" },
      } as any)
    ).toThrow();
  });

  it("throws when BOTH channelId and dmConversationId are provided", () => {
    const db = createInsertBuilderMock();
    expect(() =>
      readStateQueries.markReadToMessageBuilder(db, {
        userId: "u_1",
        channelId: "c_1",
        dmConversationId: "dm_1",
        message: { id: "m_9", createdAt: "2026-07-04T00:00:00Z" },
      } as any)
    ).toThrow();
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

function makeMassMarkDbMock(opts: {
  memberChannelIds: string[];
  latestByChannel: Record<string, { id: string; createdAt: string } | undefined>;
  existingReadStateChannels: string[]; // channelIds that already have a row
}) {
  const updates: Array<{ id: string; set: any }> = [];
  const inserts: any[] = [];

  // The db has two select shapes we need to fake:
  // 1. select({channelId: communityChannel.id}).from(communityServerMember).innerJoin(communityChannel).where(...)
  //    → returns [{channelId}] rows (member channels).
  // 2. select({...}).from(communityMessage) via getLatestMessagesByChannelIds
  //    → we intercept the batched helper instead by using vi.spyOn on the module.
  // 3. select({id, channelId}).from(communityReadState).where(...) → existing rows.
  //
  // Since we can't easily distinguish select shapes on a chain mock, we drive
  // by call order: first select is member channels, second is existing rows.
  let selectCall = 0;

  const db: any = {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.groupBy = vi.fn(() => chain);
      chain.as = vi.fn(() => chain);
      chain.where = vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) {
          return Promise.resolve(opts.memberChannelIds.map((c) => ({ channelId: c })));
        }
        if (selectCall === 2) {
          // Second select is the getLatestMessagesByChannelIds subquery-inner
          // — but our spy intercepts that helper directly, so this branch is
          // reached ONLY for the existing-rows select.
          return Promise.resolve(
            opts.existingReadStateChannels.map((c, i) => ({
              id: `rs_${i}_${c}`,
              channelId: c,
            }))
          );
        }
        return Promise.resolve([]);
      });
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn((s: any) => ({
        where: vi.fn((_w: any) => {
          // where clause is eq(readState.id, u.id) — we can't inspect the id
          // trivially without evaluating the eq() operator. Instead, we log
          // the set clause and the ORDER of update calls; combined with the
          // spy on latest-messages we can reconstruct which channel each
          // update belongs to.
          updates.push({ id: "unknown", set: s });
          return Promise.resolve();
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: any) => {
        inserts.push(v);
        return Promise.resolve();
      }),
    })),
    __updates: updates,
    __inserts: inserts,
  };

  return db;
}

describe("markAllServerChannelsRead", () => {
  it("returns 0 and does nothing when the user has no member channels", async () => {
    const db = makeMassMarkDbMock({
      memberChannelIds: [],
      latestByChannel: {},
      existingReadStateChannels: [],
    });
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([]);

    const count = await readStateQueries.markAllServerChannelsRead(db, "u_1");
    expect(count).toBe(0);
    expect(db.__updates).toHaveLength(0);
    expect(db.__inserts).toHaveLength(0);
    spy.mockRestore();
  });

  it("returns 0 and skips writes when NONE of the member channels have messages", async () => {
    const db = makeMassMarkDbMock({
      memberChannelIds: ["c_a", "c_b"],
      latestByChannel: {},
      existingReadStateChannels: [],
    });
    const messageModule = await import("../../src/db/queries/community/message");
    // Every channel is empty — the batched helper returns nothing.
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([]);

    const count = await readStateQueries.markAllServerChannelsRead(db, "u_1");
    expect(count).toBe(0);
    // The invariant: empty channels get no row.
    expect(db.__updates).toHaveLength(0);
    expect(db.__inserts).toHaveLength(0);
    spy.mockRestore();
  });

  it("returns the count of non-empty channels; inserts aligned rows for channels with no existing read state", async () => {
    const db = makeMassMarkDbMock({
      memberChannelIds: ["c_a", "c_b", "c_c_empty"],
      latestByChannel: {},
      existingReadStateChannels: [],
    });
    const messageModule = await import("../../src/db/queries/community/message");
    // c_a and c_b have messages; c_c_empty has none.
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([
      { channelId: "c_a", id: "m_a_latest", createdAt: "2026-07-05T10:00:00Z" },
      { channelId: "c_b", id: "m_b_latest", createdAt: "2026-07-05T11:00:00Z" },
    ]);

    const count = await readStateQueries.markAllServerChannelsRead(db, "u_1");
    expect(count).toBe(2);
    expect(db.__updates).toHaveLength(0);
    // One batched insert containing both rows.
    expect(db.__inserts).toHaveLength(1);
    const rows = db.__inserts[0] as Array<any>;
    expect(rows).toHaveLength(2);
    // The invariant per-row: lastReadAt === message.createdAt, lastReadMessageId === message.id.
    const byChannel = Object.fromEntries(rows.map((r) => [r.channelId, r]));
    expect(byChannel["c_a"]).toMatchObject({
      userId: "u_1",
      channelId: "c_a",
      dmConversationId: null,
      lastReadAt: "2026-07-05T10:00:00Z",
      lastReadMessageId: "m_a_latest",
    });
    expect(byChannel["c_b"]).toMatchObject({
      userId: "u_1",
      channelId: "c_b",
      dmConversationId: null,
      lastReadAt: "2026-07-05T11:00:00Z",
      lastReadMessageId: "m_b_latest",
    });
    spy.mockRestore();
  });

  it("updates existing rows in place, aligned to the latest message per channel", async () => {
    const db = makeMassMarkDbMock({
      memberChannelIds: ["c_a", "c_b"],
      latestByChannel: {},
      existingReadStateChannels: ["c_a", "c_b"],
    });
    const messageModule = await import("../../src/db/queries/community/message");
    const spy = vi.spyOn(messageModule, "getLatestMessagesByChannelIds").mockResolvedValue([
      { channelId: "c_a", id: "m_a_new", createdAt: "2026-07-05T10:00:00Z" },
      { channelId: "c_b", id: "m_b_new", createdAt: "2026-07-05T11:00:00Z" },
    ]);

    const count = await readStateQueries.markAllServerChannelsRead(db, "u_1");
    expect(count).toBe(2);
    // Two UPDATEs, no INSERT.
    expect(db.__updates).toHaveLength(2);
    expect(db.__inserts).toHaveLength(0);

    // Each update's `set` carries an ALIGNED tuple — never `lastReadMessageId: null`.
    for (const u of db.__updates) {
      expect(u.set.lastReadMessageId).not.toBeNull();
      expect(typeof u.set.lastReadAt).toBe("string");
      expect(typeof u.set.lastReadMessageId).toBe("string");
    }
    // The two sets, combined, cover c_a's and c_b's aligned tuples in some order.
    const sets = db.__updates.map((u) => u.set);
    const aTuple = sets.find((s) => s.lastReadMessageId === "m_a_new");
    const bTuple = sets.find((s) => s.lastReadMessageId === "m_b_new");
    expect(aTuple).toBeDefined();
    expect(bTuple).toBeDefined();
    expect(aTuple!.lastReadAt).toBe("2026-07-05T10:00:00Z");
    expect(bTuple!.lastReadAt).toBe("2026-07-05T11:00:00Z");
    spy.mockRestore();
  });
});
