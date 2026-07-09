import { eq, and, inArray } from "drizzle-orm";
import { communityReaction } from "../../community-schema";
import type { Database } from "../../index";

export async function addReaction(
  db: Database,
  data: { messageId: string; userId: string; emoji: string }
) {
  const [row] = await db
    .insert(communityReaction)
    .values({
      messageId: data.messageId,
      userId: data.userId,
      emoji: data.emoji,
    })
    .returning();
  return row!;
}

export async function removeReaction(
  db: Database,
  data: { messageId: string; userId: string; emoji: string }
) {
  const [deleted] = await db
    .delete(communityReaction)
    .where(
      and(
        eq(communityReaction.messageId, data.messageId),
        eq(communityReaction.userId, data.userId),
        eq(communityReaction.emoji, data.emoji)
      )
    )
    .returning();
  return deleted ?? null;
}

export async function getMessageReactions(db: Database, messageId: string) {
  return db
    .select()
    .from(communityReaction)
    .where(eq(communityReaction.messageId, messageId));
}

export async function listReactionsByMessageIds(
  db: Database,
  messageIds: string[],
  currentUserId: string
) {
  if (messageIds.length === 0) return [];
  return db
    .select()
    .from(communityReaction)
    .where(inArray(communityReaction.messageId, messageIds));
}
