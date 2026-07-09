import { eq, and, or, isNull, inArray } from "drizzle-orm";
import { communityFriendship } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

// Re-export from the client-safe constants module so existing
// `queries.communityFriendship.isSelfBotFriendship` call-sites keep working
// without any behavior change. Client-side components should import from
// `@alook/shared` directly instead of going through `queries`.
import {
  SELF_BOT_FRIENDSHIP_PREFIX,
  isSelfBotFriendship,
} from "../../../constants";
export { SELF_BOT_FRIENDSHIP_PREFIX, isSelfBotFriendship };

/**
 * Look up any friendship row between two users, in either direction.
 * The schema's UNIQUE is on `(requester, addressee)` — not the unordered
 * pair — so we still have to scan both orderings ourselves.
 */
async function findExisting(
  db: Database,
  userA: string,
  userB: string,
) {
  const rows = await db
    .select()
    .from(communityFriendship)
    .where(
      or(
        and(
          eq(communityFriendship.requesterId, userA),
          eq(communityFriendship.addresseeId, userB),
        ),
        and(
          eq(communityFriendship.requesterId, userB),
          eq(communityFriendship.addresseeId, userA),
        ),
      ),
    );
  return rows[0] ?? null;
}

export type SendRequestOutcome =
  | { kind: "created"; friendship: typeof communityFriendship.$inferSelect }
  | { kind: "auto_accepted"; friendship: typeof communityFriendship.$inferSelect }

/**
 * Send a friend request. The reverse-direction case is the subtle one:
 * if B already has a pending request to A and A then "sends" to B, both
 * sides have signalled intent — promote the existing row to accepted
 * rather than letting the UNIQUE constraint reject the request or
 * leaving two pending rows around.
 *
 * Throws if the pair already has an accepted or blocked relationship.
 */
export async function sendRequest(
  db: Database,
  data: { requesterId: string; addresseeId: string },
): Promise<SendRequestOutcome> {
  const existing = await findExisting(db, data.requesterId, data.addresseeId);

  if (existing) {
    if (existing.status === "blocked") {
      throw new Error("blocked");
    }
    if (existing.status === "accepted") {
      throw new Error("already friends");
    }
    // status === "pending"
    if (
      existing.requesterId === data.addresseeId &&
      existing.addresseeId === data.requesterId
    ) {
      // Reverse-direction pending request — auto-accept it.
      const [updated] = await db
        .update(communityFriendship)
        .set({ status: "accepted", updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(communityFriendship.id, existing.id),
            eq(communityFriendship.status, "pending"),
          ),
        )
        .returning();
      if (!updated) {
        // Lost the race — fall through to insert, which will likely fail
        // the UNIQUE check and surface as a 409 in the route.
      } else {
        return { kind: "auto_accepted", friendship: updated };
      }
    }
    // Forward-direction pending already exists — let the UNIQUE conflict
    // surface so the route returns 409.
  }

  const rows = await db
    .insert(communityFriendship)
    .values({
      requesterId: data.requesterId,
      addresseeId: data.addresseeId,
      status: "pending",
    })
    .returning();
  return { kind: "created", friendship: rows[0]! };
}

/**
 * Accept a pending request atomically. Returns null if the row no longer
 * exists or was already accepted/rejected — callers should treat that as a
 * 400/409 rather than blindly succeeding.
 */
export async function acceptRequest(db: Database, friendshipId: string) {
  const rows = await db
    .update(communityFriendship)
    .set({
      status: "accepted",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(communityFriendship.id, friendshipId),
        eq(communityFriendship.status, "pending"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Reject a pending request. Atomic: returns null if the row no longer exists
 * or was already accepted (in which case rejecting is no longer valid).
 */
export async function rejectRequest(db: Database, friendshipId: string) {
  const rows = await db
    .delete(communityFriendship)
    .where(
      and(
        eq(communityFriendship.id, friendshipId),
        eq(communityFriendship.status, "pending"),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function removeFriend(db: Database, friendshipId: string) {
  const rows = await db
    .delete(communityFriendship)
    .where(eq(communityFriendship.id, friendshipId))
    .returning();
  return rows[0]!;
}

export type BlockOutcome = {
  /** The fresh blocked row inserted by this call. */
  row: typeof communityFriendship.$inferSelect;
  /** Friendship id that was deleted to make room, if any. The route uses this
   *  to broadcast a `friend.remove` so the other side's UI stays consistent. */
  removedFriendshipId: string | null;
}

export async function block(
  db: Database,
  data: { blockerId: string; targetId: string },
): Promise<BlockOutcome> {
  const existing = await findExisting(db, data.blockerId, data.targetId);

  let removedFriendshipId: string | null = null;
  if (existing) {
    if (existing.status === "blocked") {
      // Already blocked — keep it idempotent; just refresh `updatedAt` so
      // anyone re-issuing the block sees a current timestamp.
      const rows = await db
        .update(communityFriendship)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(communityFriendship.id, existing.id))
        .returning();
      return { row: rows[0]!, removedFriendshipId: null };
    }
    // Wipe the existing pending/accepted row so the blocker's row is the
    // single source of truth instead of leaving a hybrid status='blocked'
    // entry whose requester/addressee ordering may not match the blocker.
    await db
      .delete(communityFriendship)
      .where(eq(communityFriendship.id, existing.id));
    // Tell the route whether to broadcast friend.remove — only if we just
    // tore down a real friendship, not a pending request.
    if (existing.status === "accepted") {
      removedFriendshipId = existing.id;
    }
  }

  const rows = await db
    .insert(communityFriendship)
    .values({
      requesterId: data.blockerId,
      addresseeId: data.targetId,
      status: "blocked",
      blockerId: data.blockerId,
    })
    .returning();
  return { row: rows[0]!, removedFriendshipId };
}

export async function unblock(
  db: Database,
  data: { blockerId: string; targetId: string }
) {
  // Find the blocked row in either direction where blockerId matches
  const existing = await db
    .select()
    .from(communityFriendship)
    .where(
      and(
        eq(communityFriendship.status, "blocked"),
        eq(communityFriendship.blockerId, data.blockerId),
        or(
          and(
            eq(communityFriendship.requesterId, data.blockerId),
            eq(communityFriendship.addresseeId, data.targetId)
          ),
          and(
            eq(communityFriendship.requesterId, data.targetId),
            eq(communityFriendship.addresseeId, data.blockerId)
          )
        )
      )
    );

  if (!existing[0]) return null;

  const rows = await db
    .delete(communityFriendship)
    .where(eq(communityFriendship.id, existing[0].id))
    .returning();
  return rows[0]!;
}

export async function listFriends(db: Database, userId: string) {
  // Filter deletedAt IS NULL — a soft-deleted friend (bot or human) is hidden
  // from the friend list. Return shape MUST NOT include isBot/ownerUserId:
  // Bob's friend list must render zoe (someone else's bot) indistinguishably
  // from a human friend.
  const asRequester = await db
    .select({
      id: communityFriendship.id,
      friendUserId: user.id,
      friendName: user.name,
      friendEmail: user.email,
      friendImage: user.image,
      friendDiscriminator: user.discriminator,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .where(
      and(
        eq(communityFriendship.requesterId, userId),
        eq(communityFriendship.status, "accepted"),
        isNull(user.deletedAt)
      )
    );

  const asAddressee = await db
    .select({
      id: communityFriendship.id,
      friendUserId: user.id,
      friendName: user.name,
      friendEmail: user.email,
      friendImage: user.image,
      friendDiscriminator: user.discriminator,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "accepted"),
        isNull(user.deletedAt)
      )
    );

  // Owner ↔ own-bot rows are surfaced here too — bots the caller owns must
  // appear in the Friends tab so the owner can DM / mention / @-them from
  // the same surface as any other friend. No real `communityFriendship` row
  // exists for these pairs; the id is prefixed `self-bot:` so callers can
  // detect + skip friendship-only actions (remove-friend, block).
  const ownBots = await db
    .select({
      botUserId: user.id,
      botName: user.name,
      botEmail: user.email,
      botImage: user.image,
      botDiscriminator: user.discriminator,
    })
    .from(user)
    .where(
      and(
        eq(user.ownerUserId, userId),
        eq(user.isBot, true),
        isNull(user.deletedAt)
      )
    );
  const ownBotRows = ownBots.map((b) => ({
    id: SELF_BOT_FRIENDSHIP_PREFIX + b.botUserId,
    friendUserId: b.botUserId,
    friendName: b.botName,
    friendEmail: b.botEmail,
    friendImage: b.botImage,
    friendDiscriminator: b.botDiscriminator,
  }));

  return [...asRequester, ...asAddressee, ...ownBotRows];
}

/**
 * Ids-only variant of `listFriends` — no name/email/image columns. Used on
 * hot paths that only need "who is this user's friend" (WS presence
 * fan-out via `ws-durable.ts`'s `getPresenceAudience`, and the
 * `/friends/presence` bulk-check route).
 *
 * DOES include the owner↔own-bot implicit friendship (same rule as
 * `areFriends`/`listFriends` — no real `communityFriendship` row exists for
 * the pair, but they act like friends everywhere), because both real
 * callers are presence checks and a bot's presence is meaningless without
 * its owner in the audience. An earlier revision deliberately excluded
 * these rows here (to match `listFriends`' "no join" cost-saving, not
 * realizing that trimmed the whole reason a bot's owner needs to be in this
 * list) — that's what caused a bot's owner to never learn about its own
 * presence, see plans/community-account-debt-fixes.md Fix 3 hotfix.
 */
export async function getFriendUserIds(db: Database, userId: string): Promise<string[]> {
  const [rows, selfBotRows] = await Promise.all([
    db
      .select({
        requesterId: communityFriendship.requesterId,
        addresseeId: communityFriendship.addresseeId,
      })
      .from(communityFriendship)
      .where(
        and(
          eq(communityFriendship.status, "accepted"),
          or(
            eq(communityFriendship.requesterId, userId),
            eq(communityFriendship.addresseeId, userId),
          ),
        ),
      ),
    db
      .select({ id: user.id, ownerUserId: user.ownerUserId })
      .from(user)
      .where(
        and(
          eq(user.isBot, true),
          or(eq(user.id, userId), eq(user.ownerUserId, userId)),
          isNull(user.deletedAt)
        )
      ),
  ]);
  const friendIds = rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId));
  const selfBotIds = selfBotRows
    .map((r) => (r.id === userId ? r.ownerUserId : r.id))
    .filter((id): id is string => !!id);

  // Filter out any side of the implicit friendship whose OWNER is
  // soft-deleted. The `selfBotRows` query already skips soft-deleted
  // BOT rows via `isNull(user.deletedAt)`, but a bot's owner may be
  // soft-deleted while the bot itself lives on. Without this second
  // filter, `getPresenceAudience(botId)` would keep including the
  // tombstoned owner's id forever — every presence flip would fire a
  // DO fetch to a dead account for the life of the binding.
  const otherSideIds = selfBotIds.filter((id) => id !== userId);
  if (otherSideIds.length === 0) {
    return [...new Set([...friendIds, ...selfBotIds])];
  }
  const liveOthers = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, otherSideIds), isNull(user.deletedAt)));
  const liveOtherSet = new Set(liveOthers.map((r) => r.id));
  const liveSelfBotIds = selfBotIds.filter((id) => liveOtherSet.has(id));
  return [...new Set([...friendIds, ...liveSelfBotIds])];
}

/**
 * Are two users in an `accepted` friendship? Direction-agnostic. Used by the
 * bot-server-add flow (friend-of-bot path) and DM peer allow-list.
 */
export async function areFriends(
  db: Database,
  userA: string,
  userB: string
): Promise<boolean> {
  // Owner ↔ own-bot is an implicit friendship (no row exists but they act
  // like friends everywhere). Check both directions so callers don't have to
  // know which side is the bot.
  const selfBotRows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        eq(user.isBot, true),
        or(
          and(eq(user.id, userA), eq(user.ownerUserId, userB)),
          and(eq(user.id, userB), eq(user.ownerUserId, userA))
        )
      )
    )
    .limit(1);
  if (selfBotRows.length > 0) return true;

  const rows = await db
    .select({ id: communityFriendship.id })
    .from(communityFriendship)
    .where(
      and(
        eq(communityFriendship.status, "accepted"),
        or(
          and(
            eq(communityFriendship.requesterId, userA),
            eq(communityFriendship.addresseeId, userB)
          ),
          and(
            eq(communityFriendship.requesterId, userB),
            eq(communityFriendship.addresseeId, userA)
          )
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Directly create an already-accepted friendship. Used by the bot approval
 * flow — approve implies both parties agree, so we skip the pending state.
 * If a row already exists in either direction, returns null and lets the
 * caller treat it as idempotent.
 */
export async function createAcceptedFriendship(
  db: Database,
  data: { requesterId: string; addresseeId: string }
): Promise<typeof communityFriendship.$inferSelect | null> {
  const existing = await findExisting(db, data.requesterId, data.addresseeId);
  if (existing) {
    if (existing.status === "accepted") return existing;
    if (existing.status === "blocked") return null;
    // pending — promote to accepted
    const rows = await db
      .update(communityFriendship)
      .set({ status: "accepted", updatedAt: new Date().toISOString() })
      .where(eq(communityFriendship.id, existing.id))
      .returning();
    return rows[0] ?? null;
  }
  const rows = await db
    .insert(communityFriendship)
    .values({
      requesterId: data.requesterId,
      addresseeId: data.addresseeId,
      status: "accepted",
    })
    .returning();
  return rows[0] ?? null;
}

export async function getFriendship(db: Database, friendshipId: string) {
  const rows = await db
    .select()
    .from(communityFriendship)
    .where(eq(communityFriendship.id, friendshipId));
  return rows[0] ?? null;
}

export async function isBlocked(
  db: Database,
  userId1: string,
  userId2: string
) {
  const rows = await db
    .select()
    .from(communityFriendship)
    .where(
      and(
        eq(communityFriendship.status, "blocked"),
        or(
          and(
            eq(communityFriendship.requesterId, userId1),
            eq(communityFriendship.addresseeId, userId2)
          ),
          and(
            eq(communityFriendship.requesterId, userId2),
            eq(communityFriendship.addresseeId, userId1)
          )
        )
      )
    );
  return rows.length > 0;
}

export async function listBlocked(db: Database, userId: string) {
  const asRequester = await db
    .select({
      id: communityFriendship.id,
      blockedUserId: user.id,
      blockedName: user.name,
      blockedImage: user.image,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .where(
      and(
        eq(communityFriendship.requesterId, userId),
        eq(communityFriendship.status, "blocked"),
        eq(communityFriendship.blockerId, userId)
      )
    );

  const asAddressee = await db
    .select({
      id: communityFriendship.id,
      blockedUserId: user.id,
      blockedName: user.name,
      blockedImage: user.image,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "blocked"),
        eq(communityFriendship.blockerId, userId)
      )
    );

  return [...asRequester, ...asAddressee];
}

export async function listPending(db: Database, userId: string) {
  const incoming = await db
    .select({
      id: communityFriendship.id,
      userId: user.id,
      name: user.name,
      image: user.image,
      createdAt: communityFriendship.createdAt,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "pending")
      )
    );

  const outgoing = await db
    .select({
      id: communityFriendship.id,
      userId: user.id,
      name: user.name,
      image: user.image,
      createdAt: communityFriendship.createdAt,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .where(
      and(
        eq(communityFriendship.requesterId, userId),
        eq(communityFriendship.status, "pending")
      )
    );

  return [
    ...incoming.map((r) => ({ ...r, kind: "incoming" as const })),
    ...outgoing.map((r) => ({ ...r, kind: "outgoing" as const })),
  ];
}
