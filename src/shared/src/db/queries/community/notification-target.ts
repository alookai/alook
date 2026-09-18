import { aliasedTable, asc, eq } from "drizzle-orm";
import {
  communityAttachment,
  communityChannel,
  communityMessage,
  communityServer,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

export interface PushNotificationTarget {
  messageId: string;
  channelId: string;
  authorName: string;
  content: string;
  conversationKind: "dm" | "channel" | "thread";
  serverName: string | null;
  channelName: string | null;
  parentChannelName: string | null;
  attachmentContentTypes: Array<string | null>;
}

export async function getPushNotificationTarget(
  db: Database,
  messageId: string,
): Promise<PushNotificationTarget | null> {
  const parentChannel = aliasedTable(
    communityChannel,
    "push_notification_parent_channel",
  );
  const rows = await db
    .select({
      messageId: communityMessage.id,
      channelId: communityMessage.channelId,
      authorName: user.name,
      content: communityMessage.content,
      channelType: communityChannel.type,
      channelName: communityChannel.name,
      parentChannelId: communityChannel.parentChannelId,
      parentChannelName: parentChannel.name,
      serverName: communityServer.name,
    })
    .from(communityMessage)
    .innerJoin(user, eq(user.id, communityMessage.authorId))
    .innerJoin(
      communityChannel,
      eq(communityChannel.id, communityMessage.channelId),
    )
    .leftJoin(
      parentChannel,
      eq(parentChannel.id, communityChannel.parentChannelId),
    )
    .leftJoin(
      communityServer,
      eq(communityServer.id, communityChannel.serverId),
    )
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
    messageId: message.messageId,
    channelId: message.channelId,
    authorName: message.authorName,
    content: message.content,
    conversationKind: message.channelType === "dm"
      ? "dm"
      : message.parentChannelId
        ? "thread"
        : "channel",
    serverName: message.serverName,
    channelName: message.channelName,
    parentChannelName: message.parentChannelName,
    attachmentContentTypes: attachments.map((row) => row.contentType),
  };
}
