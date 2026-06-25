import { eq, and, desc, lt, or, sql } from "drizzle-orm";
import {
  communityMessage,
  communityChannel,
  communityThread,
  communityDmConversation,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const DEFAULT_LIMIT = 50;

export async function createMessage(
  db: Database,
  data: {
    authorId: string;
    content: string;
    channelId?: string;
    dmConversationId?: string;
    threadId?: string;
    type?: string;
    mentionType?: string;
    replyToId?: string;
    embeds?: string;
  }
) {
  const now = new Date().toISOString();

  const rows = await db
    .insert(communityMessage)
    .values({
      authorId: data.authorId,
      content: data.content,
      channelId: data.channelId ?? null,
      dmConversationId: data.dmConversationId ?? null,
      threadId: data.threadId ?? null,
      type: data.type ?? "default",
      mentionType: data.mentionType ?? null,
      replyToId: data.replyToId ?? null,
      embeds: data.embeds ?? null,
    })
    .returning();

  const msg = rows[0]!;

  // Update parent lastMessageAt
  if (data.channelId) {
    await db
      .update(communityChannel)
      .set({ lastMessageAt: now })
      .where(eq(communityChannel.id, data.channelId));
  }

  if (data.dmConversationId) {
    await db
      .update(communityDmConversation)
      .set({ lastMessageAt: now })
      .where(eq(communityDmConversation.id, data.dmConversationId));
  }

  if (data.threadId) {
    await db
      .update(communityThread)
      .set({
        lastMessageAt: now,
        messageCount: sql`${communityThread.messageCount} + 1`,
      })
      .where(eq(communityThread.id, data.threadId));
  }

  return msg;
}

export async function listMessages(
  db: Database,
  opts: {
    channelId?: string;
    dmConversationId?: string;
    threadId?: string;
    cursor?: { createdAt: string; id: string };
    limit?: number;
  }
) {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const conditions: ReturnType<typeof eq>[] = [];

  if (opts.channelId) {
    conditions.push(eq(communityMessage.channelId, opts.channelId));
  }
  if (opts.dmConversationId) {
    conditions.push(eq(communityMessage.dmConversationId, opts.dmConversationId));
  }
  if (opts.threadId) {
    conditions.push(eq(communityMessage.threadId, opts.threadId));
  }

  if (opts.cursor) {
    conditions.push(
      or(
        lt(communityMessage.createdAt, opts.cursor.createdAt),
        and(
          eq(communityMessage.createdAt, opts.cursor.createdAt),
          lt(communityMessage.id, opts.cursor.id)
        )
      )! as ReturnType<typeof eq>
    );
  }

  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      threadId: communityMessage.threadId,
      embeds: communityMessage.embeds,
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(and(...conditions))
    .orderBy(desc(communityMessage.createdAt), desc(communityMessage.id))
    .limit(limit);

  return rows;
}

export async function getMessage(db: Database, messageId: string) {
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
      threadId: communityMessage.threadId,
      embeds: communityMessage.embeds,
      flags: communityMessage.flags,
      createdAt: communityMessage.createdAt,
      channelId: communityMessage.channelId,
      dmConversationId: communityMessage.dmConversationId,
      authorName: user.name,
      authorEmail: user.email,
      authorImage: user.image,
    })
    .from(communityMessage)
    .innerJoin(user, eq(communityMessage.authorId, user.id))
    .where(eq(communityMessage.id, messageId));
  return rows[0] ?? null;
}
