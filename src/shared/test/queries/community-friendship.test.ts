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

/**
 * `listFriends` runs three sequential sub-queries (asRequester, asAddressee,
 * ownBots) — each `leftJoin`s `communityUserProfile` to pick up
 * statusEmoji/statusText. Route each call's resolved rows in call order
 * rather than by table, since the mock chain doesn't distinguish tables.
 */
function createListFriendsDb(opts: {
  asRequesterRows?: unknown[];
  asAddresseeRows?: unknown[];
  ownBotRows?: unknown[];
} = {}) {
  const callRows = [opts.asRequesterRows ?? [], opts.asAddresseeRows ?? [], opts.ownBotRows ?? []];
  let call = 0;
  const leftJoinCalls: unknown[] = [];
  const db: any = {
    select: vi.fn(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn((...args: unknown[]) => {
        leftJoinCalls.push(args);
        return chain;
      });
      chain.where = vi.fn(() => Promise.resolve(callRows[call++]));
      return chain;
    }),
  };
  db.__leftJoinCalls = leftJoinCalls;
  return db;
}

describe("listFriends", () => {
  it("leftJoins communityUserProfile on all three sub-queries (asRequester, asAddressee, ownBots)", async () => {
    const db = createListFriendsDb();
    await q.listFriends(db, "u_me");
    expect(db.__leftJoinCalls).toHaveLength(3);
  });

  it("passes through statusEmoji/statusText for asRequester and asAddressee rows", async () => {
    const db = createListFriendsDb({
      asRequesterRows: [{ id: "f1", friendUserId: "u_1", statusEmoji: "🎧", statusText: "Vibing" }],
      asAddresseeRows: [{ id: "f2", friendUserId: "u_2", statusEmoji: null, statusText: null }],
    });
    const result = await q.listFriends(db, "u_me");
    expect(result).toEqual([
      { id: "f1", friendUserId: "u_1", statusEmoji: "🎧", statusText: "Vibing" },
      { id: "f2", friendUserId: "u_2", statusEmoji: null, statusText: null },
    ]);
  });

  it("defaults to null (no crash) for a friend with no communityUserProfile row via the leftJoin", async () => {
    const db = createListFriendsDb({
      asRequesterRows: [{ id: "f1", friendUserId: "u_1", statusEmoji: null, statusText: null }],
    });
    const result = await q.listFriends(db, "u_me");
    expect(result[0]).toMatchObject({ statusEmoji: null, statusText: null });
  });

  it("carries statusEmoji/statusText through the ownBots mapping onto the self-bot friendship rows", async () => {
    const db = createListFriendsDb({
      ownBotRows: [{ botUserId: "bot-1", botName: "Zoe", statusEmoji: "🎮", statusText: "Gaming" }],
    });
    const result = await q.listFriends(db, "u_me");
    expect(result).toEqual([
      {
        id: q.SELF_BOT_FRIENDSHIP_PREFIX + "bot-1",
        friendUserId: "bot-1",
        friendName: "Zoe",
        friendEmail: undefined,
        friendImage: undefined,
        friendDiscriminator: undefined,
        statusEmoji: "🎮",
        statusText: "Gaming",
      },
    ]);
  });
});

/**
 * `ensureSiblingBotFriendship` precondition guard — the only branch reachable
 * without a full db.batch harness. It loads both users' flags then throws if
 * they aren't sibling bots. Route each `.from(user)` select to canned rows.
 */
function createFlagsDb(rows: Array<{ id: string; isBot: boolean; ownerUserId: string | null; name: string }>) {
  const db: any = {
    select: vi.fn(() => {
      const chain: any = {}
      chain.from = vi.fn(() => chain)
      chain.where = vi.fn(() => Promise.resolve(rows))
      return chain
    }),
  }
  return db
}

describe("ensureSiblingBotFriendship precondition guard", () => {
  it("throws when one party is a human", async () => {
    const db = createFlagsDb([
      { id: "a", isBot: false, ownerUserId: null, name: "Human" },
      { id: "b", isBot: true, ownerUserId: "owner", name: "Bot" },
    ])
    await expect(q.ensureSiblingBotFriendship(db, { botA: "a", botB: "b" })).rejects.toThrow(
      /parties must be sibling bots/,
    )
  })

  it("throws when both are bots but owned by different owners", async () => {
    const db = createFlagsDb([
      { id: "a", isBot: true, ownerUserId: "owner1", name: "BotA" },
      { id: "b", isBot: true, ownerUserId: "owner2", name: "BotB" },
    ])
    await expect(q.ensureSiblingBotFriendship(db, { botA: "a", botB: "b" })).rejects.toThrow(
      /parties must be sibling bots/,
    )
  })
})

/**
 * `cancelPendingRequest` — soft-cancels a pending row and returns the
 * DM_MESSAGE_UPDATED fanout for cards referencing it. `updateReturns` is what
 * the `UPDATE ... RETURNING` resolves to; `refMessages` is what
 * `listMessagesReferencingFriendship` (a `.select().from().innerJoin().where()`
 * chain) resolves to.
 */
function createCancelDb(updateReturns: any[], refMessages: any[] = []) {
  const db: any = {
    update: vi.fn(() => {
      const chain: any = {}
      chain.set = vi.fn(() => chain)
      chain.where = vi.fn(() => chain)
      chain.returning = vi.fn(() => Promise.resolve(updateReturns))
      return chain
    }),
    // Only reached when a row came back — buildCardUpdateBroadcasts →
    // listMessagesReferencingFriendship.
    select: vi.fn(() => {
      const chain: any = {}
      chain.from = vi.fn(() => chain)
      chain.innerJoin = vi.fn(() => chain)
      chain.where = vi.fn(() => Promise.resolve(refMessages))
      return chain
    }),
  }
  return db
}

describe("cancelPendingRequest", () => {
  it("no-ops when the row is missing or already non-pending (empty RETURNING)", async () => {
    const db = createCancelDb([])
    const res = await q.cancelPendingRequest(db, "fr_missing")
    expect(res.row).toBeNull()
    expect(res.broadcasts).toEqual([])
    // Must NOT walk the card-broadcast path when nothing was cancelled.
    expect(db.select).not.toHaveBeenCalled()
  })

  it("cancels a pending row and returns it; no cards referencing it → no broadcasts", async () => {
    const row = {
      id: "fr_1", requesterId: "u_alice", addresseeId: "bot_yara",
      status: "cancelled", needsOwnerApproval: "owner_carol",
    }
    const db = createCancelDb([row], [])
    const res = await q.cancelPendingRequest(db, "fr_1")
    expect(res.row).toMatchObject({ id: "fr_1", status: "cancelled" })
    expect(res.broadcasts).toEqual([])
    // It did look for referencing cards.
    expect(db.select).toHaveBeenCalled()
  })
})

describe("rejectRequest", () => {
  it("no-ops when the row is missing or already non-pending (empty RETURNING)", async () => {
    const db = createCancelDb([])
    const res = await q.rejectRequest(db, "fr_missing")
    expect(res.row).toBeNull()
    expect(res.broadcasts).toEqual([])
    expect(db.select).not.toHaveBeenCalled()
  })

  it("denies a pending row and returns the card-rehydration broadcasts", async () => {
    const row = {
      id: "fr_1", requesterId: "bot_bob", addresseeId: "u_alice",
      status: "denied", needsOwnerApproval: null,
    }
    const db = createCancelDb([row], [])
    const res = await q.rejectRequest(db, "fr_1")
    expect(res.row).toMatchObject({ id: "fr_1", status: "denied" })
    expect(res.broadcasts).toEqual([])
    expect(db.select).toHaveBeenCalled()
  })
})
