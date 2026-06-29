import { eq, and, or } from "drizzle-orm";
import { communityFriendship } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function sendRequest(
  db: Database,
  data: { requesterId: string; addresseeId: string }
) {
  const rows = await db
    .insert(communityFriendship)
    .values({
      requesterId: data.requesterId,
      addresseeId: data.addresseeId,
      status: "pending",
    })
    .returning();
  return rows[0]!;
}

export async function acceptRequest(db: Database, friendshipId: string) {
  const rows = await db
    .update(communityFriendship)
    .set({
      status: "accepted",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(communityFriendship.id, friendshipId))
    .returning();
  return rows[0]!;
}

export async function rejectRequest(db: Database, friendshipId: string) {
  const rows = await db
    .delete(communityFriendship)
    .where(eq(communityFriendship.id, friendshipId))
    .returning();
  return rows[0]!;
}

export async function removeFriend(db: Database, friendshipId: string) {
  const rows = await db
    .delete(communityFriendship)
    .where(eq(communityFriendship.id, friendshipId))
    .returning();
  return rows[0]!;
}

export async function block(
  db: Database,
  data: { blockerId: string; targetId: string }
) {
  // Find existing row in either direction
  const existing = await db
    .select()
    .from(communityFriendship)
    .where(
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
    );

  if (existing[0]) {
    const rows = await db
      .update(communityFriendship)
      .set({
        status: "blocked",
        blockerId: data.blockerId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(communityFriendship.id, existing[0].id))
      .returning();
    return rows[0]!;
  }

  // No existing row — insert a new one
  const rows = await db
    .insert(communityFriendship)
    .values({
      requesterId: data.blockerId,
      addresseeId: data.targetId,
      status: "blocked",
      blockerId: data.blockerId,
    })
    .returning();
  return rows[0]!;
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
  // Query where user is the requester
  const asRequester = await db
    .select({
      id: communityFriendship.id,
      friendUserId: user.id,
      friendName: user.name,
      friendEmail: user.email,
      friendImage: user.image,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.addresseeId))
    .where(
      and(
        eq(communityFriendship.requesterId, userId),
        eq(communityFriendship.status, "accepted")
      )
    );

  // Query where user is the addressee
  const asAddressee = await db
    .select({
      id: communityFriendship.id,
      friendUserId: user.id,
      friendName: user.name,
      friendEmail: user.email,
      friendImage: user.image,
    })
    .from(communityFriendship)
    .innerJoin(user, eq(user.id, communityFriendship.requesterId))
    .where(
      and(
        eq(communityFriendship.addresseeId, userId),
        eq(communityFriendship.status, "accepted")
      )
    );

  return [...asRequester, ...asAddressee];
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
