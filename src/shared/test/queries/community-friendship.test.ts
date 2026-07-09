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
function createDb(opts: { friendshipRows?: unknown[]; selfBotRows?: unknown[] } = {}) {
  const friendshipRows = opts.friendshipRows ?? [];
  const selfBotRows = opts.selfBotRows ?? [];
  const selectCalls: unknown[] = [];
  const whereCalls: unknown[] = [];
  const db: any = {
    select: vi.fn((cols: unknown) => {
      selectCalls.push(cols);
      const chain: any = {};
      chain.from = vi.fn((table: unknown) => {
        chain.where = vi.fn((cond: unknown) => {
          whereCalls.push(cond);
          return Promise.resolve(table === user ? selfBotRows : friendshipRows);
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

  it("issues exactly one `where` per sub-query (real friendships + self-bot), no extra unfiltered fetch", async () => {
    const db = createDb();
    await q.getFriendUserIds(db, "u_me");
    expect(db.__whereCalls).toHaveLength(2);
    expect(db.select).toHaveBeenCalledTimes(2);
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
