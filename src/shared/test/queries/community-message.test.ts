import { describe, it, expect, vi } from "vitest";
import * as messageQueries from "../../src/db/queries/community/message";

describe("community/message exports", () => {
  it("exports getMessagesByIds", () => {
    expect(typeof messageQueries.getMessagesByIds).toBe("function");
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
