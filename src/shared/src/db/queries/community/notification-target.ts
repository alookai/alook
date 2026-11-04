import { aliasedTable, asc, eq } from "drizzle-orm";
import {
  communityAttachment,
  communityMessageAttachment,
  communityChannel,
  communityMessage,
  communityServer,
} from "../../community-schema";
import { user } from "../../schema";
import { communityBotCreationRequest } from "../../bot-creation-schema";
import type { MessagePreviewInput } from "../../../lib/message-preview";
import type { Database } from "../../index";

export interface PushNotificationTarget extends Pick<MessagePreviewInput, "attachments" | "approval" | "botCreation" | "systemKind" | "embeds"> {
  messageId: string;
  channelId: string;
  authorName: string;
  content: string;
  conversationKind: "dm" | "channel" | "thread";
  serverName: string | null;
  channelName: string | null;
  parentChannelName: string | null;
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
      type: communityMessage.type,
      requestId: communityBotCreationRequest.id,
      friendshipId: communityMessage.friendshipId,
      embeds: communityMessage.embeds,
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
    .leftJoin(communityBotCreationRequest, eq(communityBotCreationRequest.messageId, communityMessage.id))
    .where(eq(communityMessage.id, messageId))
    .limit(1);
  const message = rows[0];
  if (!message) return null;

  const attachments = await db
    .select({ id: communityAttachment.id, name: communityAttachment.filename, contentType: communityAttachment.contentType, sizeBytes: communityAttachment.size })
    .from(communityAttachment)
    .innerJoin(communityMessageAttachment, eq(communityMessageAttachment.attachmentId, communityAttachment.id))
    .where(eq(communityMessageAttachment.messageId, messageId))
    .orderBy(
      asc(communityMessageAttachment.position),
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
    attachments,
    ...(message.friendshipId ? { approval: { friendshipId: message.friendshipId } } : {}),
    ...(message.requestId ? { botCreation: { requestId: message.requestId } } : {}),
    ...(message.type === "thread_created" ? { systemKind: "thread" as const } : {}),
    ...(Array.isArray(message.embeds) ? { embeds: message.embeds } : {}),
  };
}
