import { describe, it, expect, vi } from "vitest";
import * as messageQueries from "../../src/db/queries/community/message";
import {
  communityMessage,
  communityChannel,
  communityDmConversation,
  communityReadState,
} from "../../src/db/community-schema";

describe("community/message exports", () => {
  it("exports getMessagesByIds", () => {
    expect(typeof messageQueries.getMessagesByIds).toBe("function");
  });
  it("exports createMessage", () => {
    expect(typeof messageQueries.createMessage).toBe("function");
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
    flags: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    channelId: "ch_1",
    dmConversationId: null,
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

  it("returned rows carry the 13-field getMessage projection, no extras", async () => {
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
        "dmConversationId",
        "embeds",
        "flags",
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

/**
 * Captures each `db.insert(...)` and `db.update(...)` call in order so tests
 * can inspect which table was hit with which values/set/onConflict clauses.
 *
 * `insert(table).values(v).returning()` resolves to `[{...v, id: v.id ?? generatedId}]`
 * so the caller can read `msg.createdAt` and `msg.id` off the inserted row.
 * `insert(table).values(v).onConflictDoUpdate(cfg)` resolves to void — the
 * common upsert shape used by the author-read-watermark writes.
 */
function createCreateMessageDbMock(opts?: { messageId?: string }) {
  const inserts: Array<{ table: unknown; values?: any; onConflict?: any }> = [];
  const updates: Array<{ table: unknown; set?: any; where?: any }> = [];
  const generatedId = opts?.messageId ?? "m_generated";

  const db: any = {
    insert: vi.fn((table: unknown) => {
      const rec: { table: unknown; values?: any; onConflict?: any } = { table };
      inserts.push(rec);
      return {
        values: vi.fn((v: any) => {
          rec.values = v;
          return {
            returning: vi.fn(() =>
              Promise.resolve([{ ...v, id: v.id ?? generatedId }])
            ),
            onConflictDoUpdate: vi.fn((cfg: any) => {
              rec.onConflict = cfg;
              return Promise.resolve();
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
              return Promise.resolve();
            }),
          };
        }),
      };
    }),
    __inserts: inserts,
    __updates: updates,
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
    expect(db.__inserts[0].values.dmConversationId).toBeNull();
    // createdAt is pinned explicitly — not left to the schema $defaultFn.
    expect(typeof db.__inserts[0].values.createdAt).toBe("string");
    expect(db.__inserts[0].values.createdAt).toBe(msg.createdAt);

    // Update: bump channel lastMessageAt to the same `now`.
    expect(db.__updates[0].table).toBe(communityChannel);
    expect(db.__updates[0].set.lastMessageAt).toBe(msg.createdAt);

    // Insert #2: the author's own read-state watermark. Upsert against the
    // (userId, channelId) partial-unique index. This is the whole point of
    // the fix — the sender's own send never surfaces as unread.
    expect(db.__inserts[1].table).toBe(communityReadState);
    expect(db.__inserts[1].values).toMatchObject({
      userId: "u_author",
      channelId: "ch_1",
      dmConversationId: null,
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict).toBeDefined();
    expect(db.__inserts[1].onConflict.set).toMatchObject({
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    // targetWhere pins the partial-unique-index shape so this upsert lands on
    // the channel row, not the DM row (they share `(userId, ...)`).
    expect(db.__inserts[1].onConflict.targetWhere).toBeDefined();
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

describe("createMessage — DM path", () => {
  it("bumps dm.lastMessageAt and upserts author's read-state watermark (dmConversationId-scoped)", async () => {
    const db = createCreateMessageDbMock({ messageId: "m_dm" });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_author",
      content: "hey",
      dmConversationId: "dm_1",
    });

    // Insert #1: the message itself, with channelId null and dmConversationId set.
    expect(db.__inserts[0].table).toBe(communityMessage);
    expect(db.__inserts[0].values.channelId).toBeNull();
    expect(db.__inserts[0].values.dmConversationId).toBe("dm_1");
    expect(db.__inserts[0].values.createdAt).toBe(msg.createdAt);

    // Update: DM conversation lastMessageAt.
    expect(db.__updates[0].table).toBe(communityDmConversation);
    expect(db.__updates[0].set.lastMessageAt).toBe(msg.createdAt);

    // Insert #2: author read-state, keyed on (userId, dmConversationId) with
    // channelId null — mirrors the partial-unique-index `idx_read_state_user_dm`.
    expect(db.__inserts[1].table).toBe(communityReadState);
    expect(db.__inserts[1].values).toMatchObject({
      userId: "u_author",
      channelId: null,
      dmConversationId: "dm_1",
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict.target).toEqual([
      communityReadState.userId,
      communityReadState.dmConversationId,
    ]);
    expect(db.__inserts[1].onConflict.set).toMatchObject({
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    });
    expect(db.__inserts[1].onConflict.targetWhere).toBeDefined();
  });

  it("timestamp alignment holds for DM: msg.createdAt === dm.lastMessageAt === readState.lastReadAt", async () => {
    const db = createCreateMessageDbMock();
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      dmConversationId: "dm_1",
    });
    expect(db.__updates[0].set.lastMessageAt).toBe(msg.createdAt);
    expect(db.__inserts[1].values.lastReadAt).toBe(msg.createdAt);
    expect(db.__inserts[1].onConflict.set.lastReadAt).toBe(msg.createdAt);
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

  it("dm branch: same shape but scoped by dmConversationId", async () => {
    const db = createLimitMock([
      { id: "m_dm_latest", createdAt: "2026-07-05T11:00:00Z" },
    ]);
    const result = await messageQueries.getLatestMessage(db, { dmConversationId: "dm_1" });
    expect(result).toEqual({ id: "m_dm_latest", createdAt: "2026-07-05T11:00:00Z" });
    expect(db.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when the target has no messages (empty channel / dm)", async () => {
    const db = createLimitMock([]);
    const cRes = await messageQueries.getLatestMessage(db, { channelId: "c_empty" });
    const dRes = await messageQueries.getLatestMessage(db, { dmConversationId: "dm_empty" });
    expect(cRes).toBeNull();
    expect(dRes).toBeNull();
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
  const CHANNEL_MSG = { id: "m_ch_latest", createdAt: "2026-07-05T10:00:00.000Z" };
  const DM_MSG = { id: "m_dm_latest", createdAt: "2026-07-05T11:00:00.000Z" };

  // Capture every insert/onConflict/update `set` payload that touches
  // communityReadState.
  type Capture = {
    lastReadAt?: string | null;
    lastReadMessageId?: string | null;
  };
  const writes: Capture[] = [];

  function makePropertyDb() {
    const db: any = {
      insert: vi.fn(() => ({
        values: vi.fn((v: any) => {
          if (Array.isArray(v)) {
            for (const row of v) writes.push({
              lastReadAt: row.lastReadAt,
              lastReadMessageId: row.lastReadMessageId,
            });
          } else {
            writes.push({ lastReadAt: v.lastReadAt, lastReadMessageId: v.lastReadMessageId });
          }
          const chain: any = {
            returning: vi.fn(() =>
              Promise.resolve([{ ...v, id: v.id ?? "m_generated" }])
            ),
            onConflictDoUpdate: vi.fn((cfg: any) => {
              writes.push({
                lastReadAt: cfg.set.lastReadAt,
                lastReadMessageId: cfg.set.lastReadMessageId,
              });
              return { __builder: "insert-onconflict" };
            }),
          };
          return chain;
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((s: any) => {
          writes.push({ lastReadAt: s.lastReadAt, lastReadMessageId: s.lastReadMessageId });
          return { where: vi.fn(() => Promise.resolve()) };
        }),
      })),
      select: vi.fn(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.innerJoin = vi.fn(() => chain);
        chain.groupBy = vi.fn(() => chain);
        chain.as = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve([]));
        chain.where = vi.fn(() => Promise.resolve([]));
        return chain;
      }),
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

    // Path B: markReadToMessageBuilder — DM
    const dbB = makePropertyDb();
    readState.markReadToMessageBuilder(dbB, {
      userId: "u_1",
      dmConversationId: "dm_1",
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

    // Path E: createMessage — DM branch (author read-watermark upsert)
    const dbE = makePropertyDb();
    await msg.createMessage(dbE, {
      authorId: "u_1",
      content: "hi",
      dmConversationId: "dm_new",
    });

    // Path F: markAllServerChannelsRead — one channel with a latest message,
    // no existing row → insert path.
    const dbF: any = makePropertyDb();
    // Rewire the two selects: first returns member channels, second returns
    // existing readState rows. All other selects fall through to the default
    // empty-select chain in makePropertyDb.
    let selectCall = 0;
    dbF.select = vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.groupBy = vi.fn(() => chain);
      chain.as = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve([]));
      chain.where = vi.fn(() => {
        selectCall += 1;
        if (selectCall === 1) return Promise.resolve([{ channelId: "c_mass" }]);
        return Promise.resolve([]);
      });
      return chain;
    });
    const spy = vi
      .spyOn(msg, "getLatestMessagesByChannelIds")
      .mockResolvedValue([
        { channelId: "c_mass", id: "m_mass_latest", createdAt: "2026-07-06T00:00:00.000Z" },
      ]);
    await readState.markAllServerChannelsRead(dbF, "u_1");
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
    // Add createMessage-derived valid pairs. The first insert on each of
    // dbD/dbE is the message row; its `createdAt` is `now` and `id` is
    // the returned generated id (dbD's mock returns `m_generated`).
    const createDbs: any[] = [dbD, dbE];
    for (const cdb of createDbs) {
      const firstInsertCall = cdb.insert.mock.calls[0];
      if (!firstInsertCall) continue;
      const valuesCall = cdb.insert.mock.results[0].value.values.mock.calls[0][0];
      const id = valuesCall.id ?? "m_generated";
      const createdAt = valuesCall.createdAt;
      validPairs.add(`${createdAt}|${id}`);
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
