import { describe, it, expect, vi } from "vitest";
import * as messageQueries from "../../src/db/queries/community/message";
import {
  communityMessage,
  communityChannel,
  communityDmConversation,
  communityReadState,
  communityMessageSeq,
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

  it("accepts dmConversationId scope", async () => {
    const row = { ...messageRow("m_dm"), channelId: null, dmConversationId: "dm_1" };
    const db = createSelectMock([row]);
    const result = await messageQueries.getMessageInScope(db, "m_dm", {
      dmConversationId: "dm_1",
    });
    expect(result?.dmConversationId).toBe("dm_1");
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
 * `insert(table).values(v).onConflictDoUpdate(cfg)` resolves to void for
 * every table EXCEPT `communityMessageSeq`, whose upsert is followed by a
 * `.returning({ nextSeq })` (`claimNextSeq`) — that one resolves to an
 * incrementing per-scopeKey counter (starting at 1), mirroring the real
 * `INSERT ... ON CONFLICT DO UPDATE SET next_seq = next_seq + 1` semantics.
 */
function createCreateMessageDbMock(opts?: { messageId?: string }) {
  const inserts: Array<{ table: unknown; values?: any; onConflict?: any }> = [];
  const updates: Array<{ table: unknown; set?: any; where?: any }> = [];
  const generatedId = opts?.messageId ?? "m_generated";
  const seqByScope = new Map<string, number>();

  const db: any = {
    insert: vi.fn((table: unknown) => {
      // `claimNextSeq`'s counter-row upsert (`communityMessageSeq`) is
      // intentionally NOT recorded into `__inserts` — every existing
      // assertion below indexes `__inserts[0]`/`[1]` assuming exactly the
      // message row then the read-state upsert, and this call always
      // precedes both (see `createMessage`'s "Step 0").
      if (table === communityMessageSeq) {
        return {
          values: vi.fn((v: any) => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(() => {
                const next = (seqByScope.get(v.scopeKey) ?? 0) + 1;
                seqByScope.set(v.scopeKey, next);
                return Promise.resolve([{ nextSeq: next }]);
              }),
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
            returning: vi.fn(() => Promise.resolve([{ ...v, id: v.id ?? generatedId }])),
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
    // `createMessage` now composes (insert msg, update scope) into a single
    // `db.batch(...)` for atomicity. The mock's `.returning()` / `.where()`
    // above already resolve to Promises, so we just await each one and
    // collect the per-statement result.
    batch: vi.fn(async (stmts: unknown[]) => Promise.all(stmts as Promise<unknown>[])),
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
    expect(db.__inserts[1].onConflict.setWhere).toBeDefined();
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
    expect(db.__inserts[1].onConflict.setWhere).toBeDefined();
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

describe("scopeKeyForTarget", () => {
  it("prefixes a channelId with 'channel:'", () => {
    expect(messageQueries.scopeKeyForTarget({ channelId: "c_1" })).toBe("channel:c_1");
  });

  it("prefixes a dmConversationId with 'dm:'", () => {
    expect(messageQueries.scopeKeyForTarget({ dmConversationId: "dm_1" })).toBe("dm:dm_1");
  });

  it("channelId takes precedence when both are somehow set", () => {
    expect(messageQueries.scopeKeyForTarget({ channelId: "c_1", dmConversationId: "dm_1" })).toBe(
      "channel:c_1"
    );
  });

  it("throws when neither is provided", () => {
    expect(() => messageQueries.scopeKeyForTarget({})).toThrow();
  });
});

describe("createMessage — seq assignment", () => {
  /**
   * Records every `insert(communityMessageSeq).values(v).onConflictDoUpdate(cfg)`
   * call so tests can assert the scope key and upsert shape `claimNextSeq`
   * sends, independent of the generic `createCreateMessageDbMock` helper
   * (which only exposes the DERIVED seq number, not the raw upsert args).
   */
  function createSeqSpyDbMock(opts?: { messageId?: string; seqSequence?: number[] }) {
    const base = createCreateMessageDbMock(opts);
    const seqCalls: Array<{ values: any; onConflict: any }> = [];
    let seqIdx = 0;
    const seqSequence = opts?.seqSequence;
    const originalInsert = base.insert;
    base.insert = vi.fn((table: unknown) => {
      if (table === communityMessageSeq) {
        const rec: { values: any; onConflict: any } = { values: undefined, onConflict: undefined };
        seqCalls.push(rec);
        return {
          values: vi.fn((v: any) => {
            rec.values = v;
            return {
              onConflictDoUpdate: vi.fn((cfg: any) => {
                rec.onConflict = cfg;
                return {
                  returning: vi.fn(() => {
                    const next = seqSequence ? seqSequence[seqIdx++] : 1;
                    return Promise.resolve([{ nextSeq: next }]);
                  }),
                };
              }),
            };
          }),
        };
      }
      return originalInsert(table);
    });
    base.__seqCalls = seqCalls;
    return base;
  }

  it("claims the seq scoped to 'channel:<id>' for a channel send", async () => {
    const db = createSeqSpyDbMock();
    await messageQueries.createMessage(db, { authorId: "u_1", content: "hi", channelId: "ch_1" });
    expect(db.__seqCalls).toHaveLength(1);
    expect(db.__seqCalls[0].values).toEqual({ scopeKey: "channel:ch_1", nextSeq: 1 });
    expect(db.__seqCalls[0].onConflict.target).toBe(communityMessageSeq.scopeKey);
  });

  it("claims the seq scoped to 'dm:<id>' for a DM send", async () => {
    const db = createSeqSpyDbMock();
    await messageQueries.createMessage(db, { authorId: "u_1", content: "hi", dmConversationId: "dm_1" });
    expect(db.__seqCalls[0].values).toEqual({ scopeKey: "dm:dm_1", nextSeq: 1 });
  });

  it("passes the claimed seq through to the message row AND the read-state watermark", async () => {
    const db = createSeqSpyDbMock({ seqSequence: [5] });
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

  it("passes the claimed seq through for the DM read-state watermark too", async () => {
    const db = createSeqSpyDbMock({ seqSequence: [9] });
    const msg = await messageQueries.createMessage(db, {
      authorId: "u_1",
      content: "hi",
      dmConversationId: "dm_1",
    });
    expect(msg.seq).toBe(9);
    expect(db.__inserts[1].values.lastReadSeq).toBe(9);
    expect(db.__inserts[1].onConflict.set.lastReadSeq).toBe(9);
  });

  it("consecutive sends in the same channel scope get strictly increasing seqs", async () => {
    const db = createSeqSpyDbMock({ seqSequence: [1, 2, 3] });
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

  it("the seq claim (insert into communityMessageSeq) happens before the message row insert", async () => {
    const order: string[] = [];
    const db = createSeqSpyDbMock();
    const originalInsert = db.insert;
    db.insert = vi.fn((table: unknown) => {
      order.push(table === communityMessageSeq ? "seq" : "message-or-other");
      return originalInsert(table);
    });
    await messageQueries.createMessage(db, { authorId: "u_1", content: "hi", channelId: "ch_1" });
    expect(order[0]).toBe("seq");
    expect(order[1]).toBe("message-or-other");
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
    flags: 0,
    createdAt,
    channelId: "c_1",
    dmConversationId: null,
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

  it("accepts dmConversationId scope", async () => {
    const db = createDualLimitMock([[], [listedRow("m_anchor", "2026-01-01T00:00:01.000Z")]]);
    const result = await messageQueries.listMessagesAround(db, {
      dmConversationId: "dm_1",
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

  it("accepts dmConversationId scope", async () => {
    const db = createDualLimitMock([[listedRow("m_1", "2026-01-01T00:00:01.000Z")]]);
    const result = await messageQueries.listMessagesSince(db, {
      dmConversationId: "dm_1",
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

  it("also accepts dmConversationId scope", async () => {
    const db = createSeqMock([{ maxSeq: 7 }]);
    const result = await messageQueries.getLatestMessageSeq(db, { dmConversationId: "dm_1" });
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
    let seqCounter = 0;
    const db: any = {
      insert: vi.fn((table: unknown) => ({
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
