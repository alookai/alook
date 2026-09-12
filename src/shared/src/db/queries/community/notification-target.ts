import { asc, eq } from "drizzle-orm";
import {
  communityAttachment,
  communityMessage,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export interface PushNotificationTarget {
  messageId: string;
  channelId: string;
  authorName: string;
  content: string;
  attachmentContentTypes: Array<string | null>;
}

export async function getPushNotificationTarget(
  db: Database,
  messageId: string,
): Promise<PushNotificationTarget | null> {
  const rows = await db
    .select({
      messageId: communityMessage.id,
      channelId: communityMessage.channelId,
      authorName: user.name,
      content: communityMessage.content,
    })
    .from(communityMessage)
    .innerJoin(user, eq(user.id, communityMessage.authorId))
    .where(eq(communityMessage.id, messageId))
    .limit(1);
  const message = rows[0];
  if (!message) return null;

  const attachments = await db
    .select({ contentType: communityAttachment.contentType })
    .from(communityAttachment)
    .where(eq(communityAttachment.messageId, messageId))
    .orderBy(
      asc(communityAttachment.position),
      asc(communityAttachment.createdAt),
    );

  return {
    ...message,
    attachmentContentTypes: attachments.map((row) => row.contentType),
  };
}
