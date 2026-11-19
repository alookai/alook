import { describe, it, expect, vi } from "vitest";
import * as mentionQueries from "../../src/db/queries/community/mention";
import { communityChannel, communityMention, communityMessage } from "../../src/db/community-schema";
import { user } from "../../src/db/schema";
import { createMigratedDb } from "../helpers/migrated-db";

it("uses the viewer and visible scopes for real unread mention queries", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    await db.insert(user).values(["reader", "author", "neighbor"].map(id => ({ id, name: id, email: id + "@example.test" }))).run();
    await db.insert(communityChannel).values([{ id: "visible", type: "dm" }, { id: "hidden", type: "dm" }]).run();
    await db.insert(communityMessage).values([
      { id: "direct", channelId: "visible", seq: 1, authorId: "author", createdAt: "2026-09-07T06:01:00Z" },
      { id: "reply", channelId: "visible", seq: 4, authorId: "author", createdAt: "2026-09-07T06:04:00Z" },
      { id: "handled", channelId: "visible", seq: 7, authorId: "author", createdAt: "2026-09-07T06:07:00Z" },
      { id: "hidden", channelId: "hidden", seq: 9, authorId: "author", createdAt: "2026-09-07T06:09:00Z" },
    ]).run();
    await db.insert(communityMention).values([
      { id: "direct-mention", messageId: "direct", userId: "reader" },
      { id: "reply-mention", messageId: "reply", userId: "reader", kind: "reply" },
      { id: "handled-mention", messageId: "handled", userId: "reader", read: 1 },
      { id: "hidden-mention", messageId: "hidden", userId: "reader" },
      { id: "neighbor-mention", messageId: "handled", userId: "neighbor" },
    ]).run();

    const inbox = await mentionQueries.listUnreadMentions(db, "reader", { visibleChannelIds: ["visible"] });
    expect(inbox.map(row => row.mention.id)).toEqual(["reply-mention", "direct-mention"]);
    const limited = await mentionQueries.listUnreadMentions(db, "reader", { visibleChannelIds: ["visible"], limit: 1 });
    expect(limited.map(row => row.mention.id)).toEqual(["reply-mention"]);
    await expect(mentionQueries.listUnreadMentionScopes(db, "reader", ["visible"])).resolves.toMatchObject([
      { channelId: "visible", attentionCount: 2, lastAttentionSeq: 4 },
    ]);
    await expect(mentionQueries.hasMentionForMessage(db, "direct", "reader")).resolves.toBe(true);
    await expect(mentionQueries.hasMentionForMessage(db, "reply", "reader")).resolves.toBe(false);
    await expect(mentionQueries.hasMentionForMessage(db, "direct", "neighbor")).resolves.toBe(false);
  } finally {
    sqlite.close();
  }
});

// `markChannelMentionsReadBuilder` collapses the two-step "select ids, then
// update by id" into a single UPDATE with a correlated subquery so it can go
// through `db.batch([...])`. These tests pin that the function returns a
// builder synchronously and never awaits a SELECT round-trip on its own.

function createUpdateBuilderMock() {
  // Two chain instances — `db.update(...)` and `db.select(...)` — both need
  // to return "builder-shape" objects. The subquery builder must NOT be a
  // Promise; Drizzle uses it as an SQLWrapper.
  const selectChain: any = {};
  selectChain.from = vi.fn(() => selectChain);
  selectChain.innerJoin = vi.fn(() => selectChain);
  selectChain.where = vi.fn(() => ({ __subquery: true }));

  const updateChain: any = {};
  updateChain.set = vi.fn(() => updateChain);
  updateChain.where = vi.fn(() => ({ __builder: "update-mention" }));

  const db: any = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
    __selectChain: selectChain,
    __updateChain: updateChain,
  };
  return db;
}


describe("hasMentionForMessage", () => {
  function createSelectMock(rows: unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(rows));
    return {
      select: vi.fn(() => chain),
    };
  }
  it("returns true when a mention row exists", async () => {
    const db = createSelectMock([{ id: "mention_1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mentionQueries.hasMentionForMessage(db as any, "msg_1", "u_1");
    expect(result).toBe(true);
  });
  it("returns false when no mention row exists", async () => {
    const db = createSelectMock([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await mentionQueries.hasMentionForMessage(db as any, "msg_1", "u_1");
    expect(result).toBe(false);
  });
});

describe("markChannelMentionsReadBuilder", () => {
  it("returns a builder synchronously and never awaits a select", () => {
    const db = createUpdateBuilderMock();
    const result = mentionQueries.markChannelMentionsReadBuilder(db, "u_1", "c_1");
    expect(result).toBeDefined();
    expect(result).not.toBeInstanceOf(Promise);
    // No `.then` on the update chain — batch-safe.
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.__updateChain.set).toHaveBeenCalledWith({ read: 1 });
    // The select is used purely to build a subquery — the result of
    // `.where(...)` is embedded in the UPDATE's `where inArray(...)`.
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
