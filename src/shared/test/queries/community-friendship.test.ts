import { describe, it, expect, vi } from "vitest";
import * as q from "../../src/db/queries/community/friendship";
import { user } from "../../src/db/schema";

/**
 * `getFriendUserIds` now issues two parallel selects — the real
 * `communityFriendship` rows, and the owner↔own-bot implicit-friendship rows
 * off the `user` table (see the function's doc comment). Route each mock
 * `.from(table)` to its own canned rows so the two queries don't bleed into
 * each other.
 */
function createDb(opts: {
  friendshipRows?: unknown[];
  selfBotRows?: unknown[];
  /** Live-owner filter query: which of the resolved "other-side" ids
   *  survive the `isNull(user.deletedAt)` guard. If omitted, defaults
   *  to "all ids returned by the selfBot query are live" (i.e., the
   *  filter is a no-op — historical behavior). */
  liveOtherIds?: string[];
} = {}) {
  const friendshipRows = opts.friendshipRows ?? [];
  const selfBotRows = opts.selfBotRows ?? [];
  const liveOtherIds = opts.liveOtherIds;
  const selectCalls: unknown[] = [];
  const whereCalls: unknown[] = [];
  let userSelectCount = 0;
  const db: any = {
    select: vi.fn((cols: unknown) => {
      selectCalls.push(cols);
      const chain: any = {};
      chain.from = vi.fn((table: unknown) => {
        chain.where = vi.fn((cond: unknown) => {
          whereCalls.push(cond);
          if (table !== user) return Promise.resolve(friendshipRows);
          // Two possible `user`-table queries:
          //   1. selfBotRows (isBot=true, either self or owner match)
          //   2. live-owner filter (inArray + isNull(deletedAt))
          // They fire in that order.
          userSelectCount += 1;
          if (userSelectCount === 1) return Promise.resolve(selfBotRows);
          // Live-owner filter — default is "all live" (return each other-side id).
          if (liveOtherIds === undefined) {
            const allOtherIds = (selfBotRows as Array<{ id: string; ownerUserId: string | null }>)
              .flatMap((r) => [r.id, r.ownerUserId])
              .filter((id): id is string => !!id);
            return Promise.resolve(allOtherIds.map((id) => ({ id })));
          }
          return Promise.resolve(liveOtherIds.map((id) => ({ id })));
        });
        return chain;
      });
      return chain;
    }),
  };
  db.__selectCalls = selectCalls;
  db.__whereCalls = whereCalls;
  return db;
}

describe("getFriendUserIds", () => {
  it("returns the other side's id when the caller is the requester", async () => {
    const db = createDb({ friendshipRows: [{ requesterId: "u_me", addresseeId: "u_friend1" }] });
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result).toEqual(["u_friend1"]);
  });

  it("returns the other side's id when the caller is the addressee", async () => {
    const db = createDb({ friendshipRows: [{ requesterId: "u_friend2", addresseeId: "u_me" }] });
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result).toEqual(["u_friend2"]);
  });

  it("resolves the correct side independently per row when both directions are mixed", async () => {
    const db = createDb({
      friendshipRows: [
        { requesterId: "u_me", addresseeId: "u_friend1" },
        { requesterId: "u_friend2", addresseeId: "u_me" },
      ],
    });
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result.sort()).toEqual(["u_friend1", "u_friend2"]);
  });

  it("returns [] when the user has no accepted friendships and owns/is no bot", async () => {
    const db = createDb();
    const result = await q.getFriendUserIds(db, "u_me");
    expect(result).toEqual([]);
  });

  it("issues exactly one `where` per sub-query (real friendships + self-bot), no extra unfiltered fetch — no self-bot pair means no 3rd query", async () => {
    const db = createDb();
    await q.getFriendUserIds(db, "u_me");
    expect(db.__whereCalls).toHaveLength(2);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("adds a THIRD query (live-owner filter) when a self-bot pair exists — needed to filter tombstoned owners", async () => {
    const db = createDb({ selfBotRows: [{ id: "bot-1", ownerUserId: "owner-1" }] });
    await q.getFriendUserIds(db, "bot-1");
    expect(db.__whereCalls).toHaveLength(3);
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("filters out a soft-deleted OWNER from the returned audience (regression guard)", async () => {
    // Bot binding still points at a live bot row; the owner has been
    // soft-deleted. The bot query above (`selfBotRows`) filters
    // `isNull(user.deletedAt)` on the BOT row only. Without the added
    // live-owner filter, the tombstoned owner id stays in the returned
    // audience forever, and every presence flip fires a DO fetch to a
    // dead account.
    const db = createDb({
      selfBotRows: [{ id: "bot-1", ownerUserId: "owner-1" }],
      liveOtherIds: [], // owner-1 does NOT come back from the live filter
    });
    const result = await q.getFriendUserIds(db, "bot-1");
    expect(result).not.toContain("owner-1");
    expect(result).toEqual([]);
  });

  // Owner↔own-bot implicit friendship — see `areFriends`/`listFriends`: no
  // real `communityFriendship` row exists for the pair, but `getFriendUserIds`
  // must surface it too, since its only two real callers (WS presence
  // fan-out, `/friends/presence` bulk-check) both need a bot's presence to
  // reach its owner and vice versa.
  it("includes the owner when called with a bot's own id", async () => {
    const db = createDb({ selfBotRows: [{ id: "bot-1", ownerUserId: "owner-1" }] });
    const result = await q.getFriendUserIds(db, "bot-1");
    expect(result).toEqual(["owner-1"]);
  });

  it("includes every owned bot when called with the owner's id", async () => {
    const db = createDb({
      selfBotRows: [
        { id: "bot-1", ownerUserId: "owner-1" },
        { id: "bot-2", ownerUserId: "owner-1" },
      ],
    });
    const result = await q.getFriendUserIds(db, "owner-1");
    expect(result.sort()).toEqual(["bot-1", "bot-2"]);
  });

  it("merges real friends and self-bot links without duplicates", async () => {
    const db = createDb({
      friendshipRows: [{ requesterId: "owner-1", addresseeId: "friend-x" }],
      selfBotRows: [{ id: "bot-1", ownerUserId: "owner-1" }],
    });
    const result = await q.getFriendUserIds(db, "owner-1");
    expect(new Set(result)).toEqual(new Set(["friend-x", "bot-1"]));
    expect(result).toHaveLength(2);
  });

  it("dedupes when a bot is somehow also a real accepted-friendship row", async () => {
    const db = createDb({
      friendshipRows: [{ requesterId: "owner-1", addresseeId: "bot-1" }],
      selfBotRows: [{ id: "bot-1", ownerUserId: "owner-1" }],
    });
    const result = await q.getFriendUserIds(db, "owner-1");
    expect(result).toEqual(["bot-1"]);
  });
});
