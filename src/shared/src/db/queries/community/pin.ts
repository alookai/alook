import { eq, and, desc } from "drizzle-orm";
import { communityPin, communityMessage } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export async function pinMessage(
  db: Database,
  data: { channelId: string; messageId: string; pinnedBy: string }
) {
  const [row] = await db
    .insert(communityPin)
    .values({
      channelId: data.channelId,
      messageId: data.messageId,
      pinnedBy: data.pinnedBy,
    })
    .returning();
  return row!;
}

export async function unpinMessage(
  db: Database,
  data: { channelId: string; messageId: string }
) {
  const [deleted] = await db
    .delete(communityPin)
    .where(
      and(
        eq(communityPin.channelId, data.channelId),
        eq(communityPin.messageId, data.messageId)
      )
    )
    .returning();
  return deleted ?? null;
}

export async function listPins(db: Database, channelId: string) {
  return db
    .select({
      pin: communityPin,
      message: communityMessage,
      author: user,
    })
    .from(communityPin)
    .innerJoin(communityMessage, eq(communityPin.messageId, communityMessage.id))
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(eq(communityPin.channelId, channelId))
    .orderBy(desc(communityPin.createdAt));
}
