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
