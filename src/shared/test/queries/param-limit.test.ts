import { describe, it, expect, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import {
  communityMention,
  communityReadState,
  communityChannelMember,
  communityServerFolderItem,
} from "../../src/db/community-schema";
import * as mentionQueries from "../../src/db/queries/community/mention";
import * as attachmentQueries from "../../src/db/queries/community/attachment";
import { D1_MAX_BIND_PARAMS } from "../../src/db/queries/_chunk";

const fakeDb = drizzle({} as never);

// The REAL number of bind params a multi-row insert emits per row. Drizzle binds
// every non-disabled column of every row (including a $defaultFn primary key and
// literal-default columns), so we count params on the actually-built statement
// rather than trusting the "logical" column count. This locks the caps in
// _chunk usage against schema drift — add a column, this test forces a re-cap.
function paramsPerRow(table: Parameters<typeof fakeDb.insert>[0], row: Record<string, unknown>): number {
  const two = fakeDb
    .insert(table)
    .values([row, row])
    .toSQL();
  return two.params.length / 2;
}

describe("real emitted params per row (pins the insert caps)", () => {
  it("communityMention = 5", () => {
    const p = paramsPerRow(communityMention, {
      messageId: "m1",
      userId: "u1",
      kind: "mention",
    });
    expect(p).toBe(5);
  });

  it("communityReadState = 6", () => {
    const p = paramsPerRow(communityReadState, {
      userId: "u1",
      channelId: "c1",
      lastReadAt: "2026-01-01T00:00:00.000Z",
      lastReadMessageId: "m1",
    });
    expect(p).toBe(6);
  });

  it("communityChannelMember = 6", () => {
    const p = paramsPerRow(communityChannelMember, {
      channelId: "c1",
      userId: "u1",
      relation: "notify",
      source: "mention",
    });
    expect(p).toBe(6);
  });

  it("communityServerFolderItem = 3", () => {
    const p = paramsPerRow(communityServerFolderItem, {
      folderId: "f1",
      serverId: "s1",
      position: 0,
    });
    expect(p).toBe(3);
  });
});

// Capturing db that records each insert's row count and resolves .returning().
function makeInsertCapture() {
  const inserts: number[] = [];
  const db: any = {
    insert: vi.fn(() => {
      const builder: any = {};
      builder.values = vi.fn((rows: unknown[]) => {
        inserts.push(rows.length);
        const chainable: any = {
          returning: vi.fn(() =>
            Promise.resolve((rows as Record<string, unknown>[]).map((r, i) => ({ ...r, id: `row-${inserts.length}-${i}` })))
          ),
          onConflictDoNothing: vi.fn(() => Promise.resolve()),
        };
        return chainable;
      });
      return builder;
    }),
  };
  return { db, inserts };
}

describe("createMentions chunking", () => {
  it("100 userIds → 5 insert statements of ≤20 rows, returns all 100", async () => {
    const { db, inserts } = makeInsertCapture();
    const userIds = Array.from({ length: 100 }, (_, i) => `u${i}`);
    const rows = await mentionQueries.createMentions(db, {
      messageId: "m1",
      userIds,
    });
    // 5 params/row → cap 20 → 100/20 = 5 statements.
    expect(inserts).toEqual([20, 20, 20, 20, 20]);
    for (const n of inserts) expect(n * 5).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
    expect(rows).toHaveLength(100);
  });

  it("empty userIds → no insert", async () => {
    const { db, inserts } = makeInsertCapture();
    const rows = await mentionQueries.createMentions(db, { messageId: "m1", userIds: [] });
    expect(inserts).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("21 userIds → 2 statements (20 + 1)", async () => {
    const { db, inserts } = makeInsertCapture();
    const userIds = Array.from({ length: 21 }, (_, i) => `u${i}`);
    await mentionQueries.createMentions(db, { messageId: "m1", userIds });
    expect(inserts).toEqual([20, 1]);
  });
});

// Capturing db for a chunked SELECT that ends in .orderBy(). Returns rows by
// call index (chunk order is deterministic: first chunk = ids[0..89], etc.).
function makeSelectCapture(rowsPerCall: unknown[][]) {
  let call = 0;
  const db: any = {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => Promise.resolve(rowsPerCall[call++] ?? []));
      return chain;
    }),
  };
  return { db, callCount: () => call };
}

describe("listByMessageIds chunking + global re-sort", () => {
  it("150 ids → 2 chunks, rows re-sorted globally by (position, createdAt)", async () => {
    // First chunk returns position 2; second chunk returns position 1. A correct
    // global re-sort must put position 1 first even though its chunk ran second
    // (per-chunk order alone would be wrong).
    const { db, callCount } = makeSelectCapture([
      [{ messageId: "m0", position: 2, createdAt: "2026-01-01T00:00:02.000Z" }],
      [{ messageId: "m100", position: 1, createdAt: "2026-01-01T00:00:01.000Z" }],
    ]);
    const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);
    const rows = await attachmentQueries.listByMessageIds(db, ids);
    expect(callCount()).toBe(2); // 150 ids → 2 chunks (90 + 60)
    expect(rows.map((r: any) => r.position)).toEqual([1, 2]);
  });
});
