import { describe, it, expect, vi } from "vitest";
import { bumpReadCursor } from "../../src/db/queries/community/read-state";
import { communityReadState } from "../../src/db/community-schema";

/**
 * `bumpReadCursor` does exactly two selects in order (`getMessageByChannelAndSeq`,
 * then `getReadState`) before its conditional insert/upsert — the thenable
 * chain trick from `community-agent-inbox.test.ts` covers both regardless of
 * which builder method ends up "last" in each call.
 */
function createMockDb(selectResponses: unknown[][]) {
  let call = 0;
  const methods = ["from", "where"];
  const select = vi.fn(() => {
    const idx = call++;
    const chain: any = {};
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.then = (resolve: any, reject: any) =>
      Promise.resolve(selectResponses[idx] ?? []).then(resolve, reject);
    return chain;
  });
  const insertCalls: Array<{ values: any; onConflict: any }> = [];
  const insert = vi.fn(() => ({
    values: vi.fn((v: any) => {
      const rec = { values: v, onConflict: undefined as any };
      insertCalls.push(rec);
      return {
        onConflictDoUpdate: vi.fn((cfg: any) => {
          rec.onConflict = cfg;
          return Promise.resolve();
        }),
      };
    }),
  }));
  return { select, insert, __insertCalls: insertCalls } as any;
}

describe("bumpReadCursor", () => {
  it("returns null when seq doesn't resolve to a real message in that scope", async () => {
    const db = createMockDb([[], []]); // getMessageByChannelAndSeq → no rows
    const result = await bumpReadCursor(db, "u_1", { channelId: "ch_1" }, 99);
    expect(result).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("upserts lastReadMessageId/lastReadAt/lastReadSeq TOGETHER, aligned to the resolved message — never lastReadSeq alone", async () => {
    const db = createMockDb([
      [{ id: "m_5", createdAt: "2026-07-05T10:00:00.000Z", seq: 5 }], // getMessageByChannelAndSeq
      [], // getReadState — no existing row
    ]);
    const result = await bumpReadCursor(db, "u_1", { channelId: "ch_1" }, 5);
    expect(result).toEqual({ id: "m_5", createdAt: "2026-07-05T10:00:00.000Z", seq: 5 });
    expect(db.__insertCalls).toHaveLength(1);
    expect(db.__insertCalls[0].values).toMatchObject({
      userId: "u_1",
      channelId: "ch_1",
      dmConversationId: null,
      lastReadAt: "2026-07-05T10:00:00.000Z",
      lastReadMessageId: "m_5",
      lastReadSeq: 5,
    });
    expect(db.__insertCalls[0].onConflict.set).toMatchObject({
      lastReadAt: "2026-07-05T10:00:00.000Z",
      lastReadMessageId: "m_5",
      lastReadSeq: 5,
    });
    expect(db.__insertCalls[0].onConflict.setWhere).toBeDefined();
    expect(db.__insertCalls[0].onConflict.target).toEqual([
      communityReadState.userId,
      communityReadState.channelId,
    ]);
  });

  it("DM path: channelId is null, dmConversationId carries the scope", async () => {
    const db = createMockDb([
      [{ id: "m_dm_1", createdAt: "2026-07-05T11:00:00.000Z", seq: 3 }],
      [],
    ]);
    await bumpReadCursor(db, "u_1", { dmConversationId: "dm_1" }, 3);
    expect(db.__insertCalls[0].values).toMatchObject({
      channelId: null,
      dmConversationId: "dm_1",
      lastReadSeq: 3,
    });
    expect(db.__insertCalls[0].onConflict.target).toEqual([
      communityReadState.userId,
      communityReadState.dmConversationId,
    ]);
    expect(db.__insertCalls[0].onConflict.setWhere).toBeDefined();
  });

  it("idempotent — a lower/equal seq than what's already recorded is a no-op (never regresses)", async () => {
    const db = createMockDb([
      [{ id: "m_2", createdAt: "2026-07-05T09:00:00.000Z", seq: 2 }], // resolves to an OLDER message
      [{ lastReadAt: "2026-07-05T10:00:00.000Z", lastReadMessageId: "m_5", lastReadSeq: 5 }], // already ahead
    ]);
    const result = await bumpReadCursor(db, "u_1", { channelId: "ch_1" }, 2);
    // MAX semantics: existing pointer wins, no write happens.
    expect(result).toEqual({ id: "m_5", createdAt: "2026-07-05T10:00:00.000Z", seq: 5 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("advances forward when the resolved message is strictly newer than the existing watermark", async () => {
    const db = createMockDb([
      [{ id: "m_9", createdAt: "2026-07-05T12:00:00.000Z", seq: 9 }],
      [{ lastReadAt: "2026-07-05T10:00:00.000Z", lastReadMessageId: "m_5", lastReadSeq: 5 }],
    ]);
    const result = await bumpReadCursor(db, "u_1", { channelId: "ch_1" }, 9);
    expect(result).toEqual({ id: "m_9", createdAt: "2026-07-05T12:00:00.000Z", seq: 9 });
    expect(db.__insertCalls).toHaveLength(1);
    expect(db.__insertCalls[0].values.lastReadSeq).toBe(9);
  });

  it("advances by seq even when the next message has the same createdAt timestamp", async () => {
    const timestamp = "2026-07-05T10:00:00.000Z";
    const db = createMockDb([
      [{ id: "m_6", createdAt: timestamp, seq: 6 }],
      [{ lastReadAt: timestamp, lastReadMessageId: "m_5", lastReadSeq: 5 }],
    ]);

    const result = await bumpReadCursor(db, "u_1", { channelId: "ch_1" }, 6);

    expect(result).toEqual({ id: "m_6", createdAt: timestamp, seq: 6 });
    expect(db.__insertCalls).toHaveLength(1);
    expect(db.__insertCalls[0].values).toMatchObject({
      lastReadAt: timestamp,
      lastReadMessageId: "m_6",
      lastReadSeq: 6,
    });
  });
});
