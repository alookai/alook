import { describe, it, expect, vi } from "vitest";
import { createDb } from "../../src/db";
import * as inboxQueries from "../../src/db/queries/community/inbox";

describe("listUnreadForumOpeners — scoped forum projection", () => {
  function createForumOpenerMock(responseSets: any[][]) {
    let call = 0;
    const chain: any = {};
    chain.select = vi.fn((fields: any) => fields?.value ? createDb({} as any).select(fields) : chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(responseSets[call++] ?? []));
    return chain;
  }

  const raw = (overrides: Partial<{
    forumChannelId: string;
    openerMessageId: string;
    openerContent: string;
    openerSeq: number;
    childChannelId: string;
    childName: string | null;
    createdAt: string;
  }> = {}) => ({
    forumChannelId: "forum_1",
    openerMessageId: "opener_1",
    openerContent: "The authoritative full opener title",
    openerSeq: 1,
    childChannelId: "post_1",
    childName: "derived truncated title",
    createdAt: "2026-07-07T10:00:00.000Z",
    ...overrides,
  });

  it("returns no rows and issues no query for an empty authorized parent scope", async () => {
    const db = createForumOpenerMock([]);
    await expect(inboxQueries.listUnreadForumOpeners(db, "u1", [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("projects opener identity, child identity, full opener content, createdAt, and seq", async () => {
    const db = createForumOpenerMock([[raw()]]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ["forum_1"]);
    expect(result).toEqual([{
      forumChannelId: "forum_1",
      openerMessageId: "opener_1",
      childChannelId: "post_1",
      title: "The authoritative full opener title",
      createdAt: "2026-07-07T10:00:00.000Z",
      openerSeq: 1,
    }]);
  });

  it("falls back to the derived child name only when opener content is blank", async () => {
    const db = createForumOpenerMock([[
      raw({ openerMessageId: "blank", openerContent: "  ", childName: "Fallback title" }),
      raw({ openerMessageId: "full", openerContent: "  preserve me  ", childName: "Wrong" }),
    ]]);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ["forum_1"]);
    expect(Object.fromEntries(result.map((row) => [row.openerMessageId, row.title]))).toEqual({
      blank: "Fallback title",
      full: "  preserve me  ",
    });
  });

  it("uses one authorized set predicate and globally sorts createdAt, seq, then id", async () => {
    const firstChunk = [
      raw({ openerMessageId: "opener_a", openerSeq: 4, createdAt: "2026-07-07T10:00:00.000Z" }),
      raw({ openerMessageId: "opener_z", openerSeq: 8, createdAt: "2026-07-07T09:00:00.000Z" }),
    ];
    const secondChunk = [
      raw({ openerMessageId: "opener_b", openerSeq: 5, createdAt: "2026-07-07T10:00:00.000Z" }),
      raw({ openerMessageId: "opener_c", openerSeq: 5, createdAt: "2026-07-07T10:00:00.000Z" }),
    ];
    const db = createForumOpenerMock([[...firstChunk, ...secondChunk]]);
    const ids = Array.from({ length: 91 }, (_, i) => `forum_${i}`);
    const result = await inboxQueries.listUnreadForumOpeners(db, "u1", ids);

    expect(db.where).toHaveBeenCalledTimes(1);
    expect(result.map((row) => row.openerMessageId)).toEqual([
      "opener_c",
      "opener_b",
      "opener_a",
      "opener_z",
    ]);
  });
});

describe("listThreadOpenersByChildIds — child projection mapping", () => {
  function createChildOpenerMock(responseSets: any[][]) {
    let call = 0;
    const chain: any = {};
    chain.select = vi.fn((fields: any) => fields?.value ? createDb({} as any).select(fields) : chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(responseSets[call++] ?? []));
    return chain;
  }

  const raw = (overrides: Record<string, unknown> = {}) => ({
    parentChannelId: "parent_1",
    parentType: "text",
    openerMessageId: "opener_1",
    openerContent: "Canonical title",
    openerSeq: 7,
    childChannelId: "post_1",
    childName: "derived",
    createdAt: "2026-07-07T10:00:00.000Z",
    openerUnread: 1,
    ...overrides,
  });

  it("does not query for an empty authorized child scope", async () => {
    const db = createChildOpenerMock([]);
    await expect(inboxQueries.listThreadOpenersByChildIds(db, "u1", [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns full canonical content and falls back only for blank content", async () => {
    const db = createChildOpenerMock([[
      raw(),
      raw({ openerMessageId: "blank", childChannelId: "post_2", openerContent: "  ", childName: "Fallback", openerUnread: 0 }),
    ]]);
    const rows = await inboxQueries.listThreadOpenersByChildIds(db, "u1", ["post_1", "post_2"]);
    expect(rows.map((row) => [row.childChannelId, row.title])).toEqual([
      ["post_1", "Canonical title"],
      ["post_2", "Fallback"],
    ]);
    expect(rows[0]).toMatchObject({
      parentChannelId: "parent_1",
      parentType: "text",
      openerSeq: 7,
      openerUnread: true,
    });
    expect(rows[1]?.openerUnread).toBe(false);
  });

  it("uses one child set predicate and globally sorts results", async () => {
    const db = createChildOpenerMock([[
      raw({ openerMessageId: "older", childChannelId: "post_old", createdAt: "2026-07-07T09:00:00.000Z" }),
      raw({ openerMessageId: "newer", childChannelId: "post_new", createdAt: "2026-07-07T11:00:00.000Z" }),
    ]]);
    const ids = Array.from({ length: 91 }, (_, index) => `post_${index}`);
    const rows = await inboxQueries.listThreadOpenersByChildIds(db, "u1", ids);
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => row.openerMessageId)).toEqual(["newer", "older"]);
  });
});
