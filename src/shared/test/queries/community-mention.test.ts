import { describe, it, expect, vi } from "vitest";
import * as mentionQueries from "../../src/db/queries/community/mention";

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

describe("community/mention exports", () => {
  it("exports markChannelMentionsReadBuilder", () => {
    expect(typeof mentionQueries.markChannelMentionsReadBuilder).toBe("function");
  });
  it("exports hasMentionForMessage", () => {
    expect(typeof mentionQueries.hasMentionForMessage).toBe("function");
  });
});

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

describe("listMessageMentionUserIds", () => {
  it("returns one persisted attention target per user across mention kinds", async () => {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([
      { userId: "u_mention" },
      { userId: "u_reply" },
      { userId: "u_mention" },
    ]));
    const db = { select: vi.fn(() => chain) };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mentionQueries.listMessageMentionUserIds(db as any, "msg_1"),
    ).resolves.toEqual(["u_mention", "u_reply"]);
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
