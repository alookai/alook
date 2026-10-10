import { and, asc, eq, exists, getTableColumns, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { communityAttachment, communityChannel, communityChannelMember, communityFriendship, communityMessage, communityMessageAttachment } from "../../community-schema";
import { nanoid } from "nanoid";
import { user } from "../../schema";
import type { Database } from "../../index";
import { chunk, D1_MAX_IN_PARAMS } from "../_chunk";
import { channelReadableSql } from "./channel";

export async function createAttachment(db: Database, data: typeof communityAttachment.$inferInsert) {
  const [row] = await db.insert(communityAttachment).select(db.select({
    id: sql<string>`${data.id ?? nanoid()}`.as("id"),
    uploaderId: user.id,
    r2Key: sql<string>`${data.r2Key}`.as("r2_key"),
    thumbnailR2Key: sql<string | null>`${data.thumbnailR2Key ?? null}`.as("thumbnail_r2_key"),
    filename: sql<string>`${data.filename}`.as("filename"),
    contentType: sql<string | null>`${data.contentType ?? null}`.as("content_type"),
    size: sql<number | null>`${data.size ?? null}`.as("size"),
    width: sql<number | null>`${data.width ?? null}`.as("width"),
    height: sql<number | null>`${data.height ?? null}`.as("height"),
    createdAt: sql<string>`${data.createdAt ?? new Date().toISOString()}`.as("created_at"),
  }).from(user).where(and(eq(user.id, data.uploaderId), isNull(user.deletedAt)))).returning();
  if (!row) throw new Error("attachment uploader no longer exists");
  return row;
}

export function attachmentReadableSql(db: Database, userId: string) {
  const peer = alias(communityChannelMember, "attachment_dm_peer");
  const hasPeer = db.select({ id: peer.id }).from(peer)
    .where(and(eq(peer.channelId, communityChannel.id), eq(peer.relation, "access"), ne(peer.userId, userId)));
  const blocked = db.select({ id: communityFriendship.id }).from(communityFriendship)
    .innerJoin(peer, and(eq(peer.channelId, communityChannel.id), eq(peer.relation, "access"), ne(peer.userId, userId)))
    .where(and(eq(communityFriendship.status, "blocked"), or(
      and(eq(communityFriendship.requesterId, userId), eq(communityFriendship.addresseeId, peer.userId)),
      and(eq(communityFriendship.addresseeId, userId), eq(communityFriendship.requesterId, peer.userId)),
    )));
  const readableMessage = db.select({ id: communityMessage.id }).from(communityMessageAttachment)
    .innerJoin(communityMessage, eq(communityMessage.id, communityMessageAttachment.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .where(and(eq(communityMessageAttachment.attachmentId, communityAttachment.id),
      channelReadableSql(userId, { id: communityChannel.id, type: communityChannel.type, serverId: communityChannel.serverId, parentChannelId: communityChannel.parentChannelId }), or(ne(communityChannel.type, "dm"), and(exists(hasPeer), notExists(blocked)))));
  const activeActor = db.select({ id: user.id }).from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)));
  return and(exists(activeActor), or(eq(communityAttachment.uploaderId, userId), exists(readableMessage)))!;
}

export async function getReadableAttachmentById(db: Database, id: string, userId: string) {
  const [row] = await db.select().from(communityAttachment)
    .where(and(eq(communityAttachment.id, id), attachmentReadableSql(db, userId))).limit(1);
  return row ?? null;
}

function messageAttachments(db: Database, ids: string[]) {
  return db.select({ ...getTableColumns(communityAttachment), messageId: communityMessageAttachment.messageId,
    position: communityMessageAttachment.position, targetId: communityMessage.channelId })
    .from(communityMessageAttachment)
    .innerJoin(communityAttachment, eq(communityAttachment.id, communityMessageAttachment.attachmentId))
    .innerJoin(communityMessage, eq(communityMessage.id, communityMessageAttachment.messageId))
    .where(inArray(communityMessageAttachment.messageId, ids))
    .orderBy(asc(communityMessageAttachment.position), asc(communityAttachment.createdAt));
}

export async function listMessageAttachments(db: Database, messageId: string) {
  return messageAttachments(db, [messageId]);
}

export async function listByMessageIds(db: Database, messageIds: string[]) {
  const rows = (await Promise.all(chunk(messageIds, D1_MAX_IN_PARAMS).map((ids) => messageAttachments(db, ids)))).flat();
  return rows.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}
