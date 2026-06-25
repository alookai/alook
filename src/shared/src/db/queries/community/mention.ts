import { eq, and, inArray } from "drizzle-orm";
import { communityMention, communityMessage } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function createMentions(
  db: Database,
  data: { messageId: string; userIds: string[] }
) {
  if (data.userIds.length === 0) return [];

  const rows = await db
    .insert(communityMention)
    .values(
      data.userIds.map((userId) => ({
        messageId: data.messageId,
        userId,
      }))
    )
    .returning();
  return rows;
}

export async function listUnreadMentions(db: Database, userId: string) {
  return db
    .select({
      mention: communityMention,
      message: communityMessage,
      author: user,
    })
    .from(communityMention)
    .innerJoin(
      communityMessage,
      eq(communityMention.messageId, communityMessage.id)
    )
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(
      and(eq(communityMention.userId, userId), eq(communityMention.read, 0))
    );
}

export async function markMentionsRead(
  db: Database,
  userId: string,
  messageIds: string[]
) {
  if (messageIds.length === 0) return;

  await db
    .update(communityMention)
    .set({ read: 1 })
    .where(
      and(
        eq(communityMention.userId, userId),
        inArray(communityMention.messageId, messageIds)
      )
    );
}
