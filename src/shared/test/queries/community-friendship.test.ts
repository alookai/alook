import { describe, it, expect, vi } from "vitest";
import * as q from "../../src/db/queries/community/friendship";

function createSelectMock(rows: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("getFriendUserIds", () => {
  it("returns the other side's id when the caller is the requester", async () => {
    const db = createSelectMock([
      { requesterId: "u_me", addresseeId: "u_friend1" },
    ]);
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result).toEqual(["u_friend1"]);
  });

  it("returns the other side's id when the caller is the addressee", async () => {
    const db = createSelectMock([
      { requesterId: "u_friend2", addresseeId: "u_me" },
    ]);
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result).toEqual(["u_friend2"]);
  });

  it("resolves the correct side independently per row when both directions are mixed", async () => {
    const db = createSelectMock([
      { requesterId: "u_me", addresseeId: "u_friend1" },
      { requesterId: "u_friend2", addresseeId: "u_me" },
    ]);
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result.sort()).toEqual(["u_friend1", "u_friend2"]);
  });

  it("returns [] when the user has no accepted friendships", async () => {
    const db = createSelectMock([]);
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result).toEqual([]);
  });

  it("only queries rows filtered by status=accepted (pending/blocked excluded at the query layer)", async () => {
    // The mock DB can't express SQL predicates, but we can pin that the
    // query issues exactly one `where` — the status/direction filter — so a
    // future edit can't silently add a second unfiltered fetch-and-merge.
    const db = createSelectMock([]);
    await q.getFriendUserIds(db, "u_me");
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
