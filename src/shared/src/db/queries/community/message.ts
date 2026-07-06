import { eq, and, desc, lt, or, sql, inArray } from "drizzle-orm";
import {
  communityMessage,
  communityChannel,
  communityDmConversation,
} from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { createLogger } from "../../../logger";

const DEFAULT_LIMIT = 50;

// Module-level logger so every parse failure lands on the same service tag.
// Shared with any consumer of these queries; the alternative (plumbing a
// logger down through 30+ call sites) buys nothing here.
const log = createLogger({ service: "community-queries" });

// TEXT column at rest → JSON at the boundary. Isolating the parse here keeps
// storage-format concerns out of every route.
function safeParseEmbeds(raw: string | null, messageId: string): unknown | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn("embeds_parse_failed", { messageId, err });
    return undefined;
  }
}

export async function createMessage(
  db: Database,
  data: {
    authorId: string;
    content: string;
    channelId?: string;
    dmConversationId?: string;
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
      type: data.type ?? "default",
      mentionType: data.mentionType ?? null,
      replyToId: data.replyToId ?? null,
      embeds: data.embeds ?? null,
    })
    .returning();

  const msg = rows[0]!;

  if (data.channelId) {
    await db
      .update(communityChannel)
      .set({
        lastMessageAt: now,
        messageCount: sql`${communityChannel.messageCount} + 1`,
      })
      .where(eq(communityChannel.id, data.channelId));
  }

  if (data.dmConversationId) {
    await db
      .update(communityDmConversation)
      .set({ lastMessageAt: now })
      .where(eq(communityDmConversation.id, data.dmConversationId));
  }

  return msg;
}

/**
 * Hard-delete a message row by id. Reserved for rollback of a message that
 * was written moments before but its dependent row (approval-request, etc.)
 * failed to persist. Do NOT use this for user-facing message deletion — that
 * path should soft-delete or set a tombstone.
 */
export async function hardDeleteMessage(db: Database, messageId: string) {
  await db.delete(communityMessage).where(eq(communityMessage.id, messageId));
}

export async function listMessages(
  db: Database,
  opts: {
    channelId?: string;
    dmConversationId?: string;
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

  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
}

export async function getFirstMessageByChannelIds(db: Database, channelIds: string[]) {
  if (channelIds.length === 0) return [];
  // Use a subquery to get the min createdAt per channel, then join to get the content
  const firstDates = db
    .select({
      channelId: communityMessage.channelId,
      minCreatedAt: sql<string>`MIN(${communityMessage.createdAt})`.as("min_created_at"),
    })
    .from(communityMessage)
    .where(inArray(communityMessage.channelId, channelIds))
    .groupBy(communityMessage.channelId)
    .as("first_dates");

  const rows = await db
    .select({
      channelId: communityMessage.channelId,
      content: communityMessage.content,
    })
    .from(communityMessage)
    .innerJoin(
      firstDates,
      and(
        eq(communityMessage.channelId, firstDates.channelId),
        eq(communityMessage.createdAt, firstDates.minCreatedAt)
      )
    );

  // Deduplicate in case of exact same createdAt within a channel
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.channelId || seen.has(r.channelId)) return false;
    seen.add(r.channelId);
    return true;
  });
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
  const row = rows[0];
  if (!row) return null;
  return { ...row, embeds: safeParseEmbeds(row.embeds, row.id) };
}

// No ordering guarantee — callers build a Map<id, row> and hydrate by id.
// Unknown ids silently drop out via the natural WHERE id IN (...) semantics.
export async function getMessagesByIds(db: Database, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: communityMessage.id,
      authorId: communityMessage.authorId,
      content: communityMessage.content,
      type: communityMessage.type,
      mentionType: communityMessage.mentionType,
      replyToId: communityMessage.replyToId,
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
    .where(inArray(communityMessage.id, ids));
  return rows.map((r) => ({ ...r, embeds: safeParseEmbeds(r.embeds, r.id) }));
}
