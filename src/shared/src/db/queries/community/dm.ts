import { eq, and, or, desc, isNull } from "drizzle-orm";
import { communityDmConversation } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function createOrGetDM(
  db: Database,
  data: { userId1: string; userId2: string }
) {
  // Normalize: user1Id is always the lexicographically smaller ID
  const [user1Id, user2Id] = [data.userId1, data.userId2].sort() as [
    string,
    string,
  ];

  // Try to find existing
  const existing = await db
    .select()
    .from(communityDmConversation)
    .where(
      and(
        eq(communityDmConversation.user1Id, user1Id),
        eq(communityDmConversation.user2Id, user2Id)
      )
    );

  if (existing[0]) return existing[0];

  // Insert new
  const rows = await db
    .insert(communityDmConversation)
    .values({ user1Id, user2Id })
    .returning();
  return rows[0]!;
}

export async function listDMs(db: Database, userId: string) {
  // Where user is user1 — join to get user2 info
  const asUser1 = await db
    .select({
      id: communityDmConversation.id,
      otherUserId: user.id,
      otherUserName: user.name,
      otherUserEmail: user.email,
      otherUserImage: user.image,
      otherUserDiscriminator: user.discriminator,
      lastMessageAt: communityDmConversation.lastMessageAt,
      createdAt: communityDmConversation.createdAt,
    })
    .from(communityDmConversation)
    .innerJoin(user, eq(user.id, communityDmConversation.user2Id))
    .where(and(eq(communityDmConversation.user1Id, userId), isNull(user.deletedAt)))
    // filtered in the WHERE above; sorted here.
    .orderBy(desc(communityDmConversation.lastMessageAt));

  // Where user is user2 — join to get user1 info
  const asUser2 = await db
    .select({
      id: communityDmConversation.id,
      otherUserId: user.id,
      otherUserName: user.name,
      otherUserEmail: user.email,
      otherUserImage: user.image,
      otherUserDiscriminator: user.discriminator,
      lastMessageAt: communityDmConversation.lastMessageAt,
      createdAt: communityDmConversation.createdAt,
    })
    .from(communityDmConversation)
    .innerJoin(user, eq(user.id, communityDmConversation.user1Id))
    .where(and(eq(communityDmConversation.user2Id, userId), isNull(user.deletedAt)))
    // filtered in the WHERE above; sorted here.
    .orderBy(desc(communityDmConversation.lastMessageAt));

  // Merge and sort by lastMessageAt DESC
  return [...asUser1, ...asUser2].sort((a, b) => {
    const aTime = a.lastMessageAt ?? a.createdAt;
    const bTime = b.lastMessageAt ?? b.createdAt;
    return bTime.localeCompare(aTime);
  });
}

export async function getDM(db: Database, dmId: string) {
  const rows = await db
    .select()
    .from(communityDmConversation)
    .where(eq(communityDmConversation.id, dmId));
  return rows[0] ?? null;
}
