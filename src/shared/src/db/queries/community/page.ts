import { and, asc, count, desc, eq, exists, getTableColumns, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../index";
import { communityMessagePage, communityPage } from "../../page-schema";
import { communityChannel, communityMessage } from "../../community-schema";
import { user, verification } from "../../schema";
import { messageChannelReadableSql } from "./channel";

const channelColumns = { id: communityChannel.id, type: communityChannel.type, serverId: communityChannel.serverId, parentChannelId: communityChannel.parentChannelId };

function activeActor(db: Database, actorId: string) {
  return exists(db.select({ id: user.id }).from(user).where(and(eq(user.id, actorId), isNull(user.deletedAt))));
}

function readableLinks(db: Database, readerId: string) {
  return db.select({ id: communityMessagePage.pageId }).from(communityMessagePage)
    .innerJoin(communityMessage, eq(communityMessage.id, communityMessagePage.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .where(and(eq(communityMessagePage.pageId, communityPage.id), messageChannelReadableSql(db, readerId, channelColumns)));
}

function getReadableResourceQuery(db: Database, id: string, readerId: string, key: "id" | "artifactId" = "id") {
  return db.select().from(communityPage).where(and(eq(communityPage[key], id), activeActor(db, readerId),
    or(eq(communityPage.botId, readerId), exists(readableLinks(db, readerId))))).limit(1);
}

export async function getReadableResource(db: Database, id: string, readerId: string, key: "id" | "artifactId" = "id") {
  const [row] = await getReadableResourceQuery(db, id, readerId, key);
  return row ?? null;
}

export async function createPage(db: Database, data: typeof communityPage.$inferInsert) {
  const [row] = await db.insert(communityPage).select(db.select({
    id: sql<string>`${data.id}`.as("id"), artifactId: sql<string>`${data.artifactId}`.as("artifact_id"),
    archiveAttachmentId: sql<string>`${data.archiveAttachmentId}`.as("archive_attachment_id"), botId: user.id,
    type: sql<string>`${data.type}`.as("type"), title: sql<string>`${data.title}`.as("title"), createdAt: sql<string>`${data.createdAt}`.as("created_at"),
  }).from(user).where(and(eq(user.id, data.botId), eq(user.isBot, true), isNull(user.deletedAt))))
    .onConflictDoNothing({ target: communityPage.id }).returning();
  return row ?? await getReadableResource(db, data.id, data.botId);
}

export function pageBindingStatement(db: Database, data: { id: string; messageId: string; authorId: string }) {
  const authorized = db.select({ id: communityPage.id }).from(communityPage).where(and(
    eq(communityPage.id, data.id), activeActor(db, data.authorId),
    or(eq(communityPage.botId, data.authorId), exists(readableLinks(db, data.authorId))),
    exists(db.select({ id: communityMessage.id }).from(communityMessage).where(and(eq(communityMessage.id, data.messageId), eq(communityMessage.authorId, data.authorId)))),
  ));
  return db.insert(communityMessagePage).values({ messageId: data.messageId, pageId: sql<string>`(${authorized})` });
}

function readablePageQuery(db: Database, key: "id" | "artifactId", value: string, readerId: string, sourceMessageId?: string) {
  return db.select({ ...getTableColumns(communityPage), messageId: communityMessage.id, sourceBotId: communityMessage.authorId, channelId: communityMessage.channelId, channelType: communityChannel.type })
    .from(communityPage).innerJoin(communityMessagePage, eq(communityMessagePage.pageId, communityPage.id))
    .innerJoin(communityMessage, eq(communityMessage.id, communityMessagePage.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .where(and(eq(communityPage[key], value), ...(sourceMessageId ? [eq(communityMessagePage.messageId, sourceMessageId)] : []), activeActor(db, readerId),
      messageChannelReadableSql(db, readerId, channelColumns))).limit(sourceMessageId ? 1 : 2);
}

async function readablePage(db: Database, key: "id" | "artifactId", value: string, readerId: string, sourceMessageId?: string) {
  const rows = await readablePageQuery(db, key, value, readerId, sourceMessageId);
  return rows.length === 1 ? rows[0]! : null;
}

export function getReadablePage(db: Database, id: string, readerId: string, sourceMessageId?: string) {
  return readablePage(db, "id", id, readerId, sourceMessageId);
}
export function getReadablePageForArtifact(db: Database, artifactId: string, readerId: string, sourceMessageId?: string) {
  return readablePage(db, "artifactId", artifactId, readerId, sourceMessageId);
}
export function getPublishedPage(db: Database, id: string, actorId: string) {
  return getReadableResource(db, id, actorId);
}

function listReadablePageChannelsQuery(db: Database, artifactId: string, readerId: string) {
  return db.selectDistinct({ channelId: communityMessage.channelId, channelType: communityChannel.type }).from(communityPage)
    .innerJoin(communityMessagePage, eq(communityMessagePage.pageId, communityPage.id))
    .innerJoin(communityMessage, eq(communityMessage.id, communityMessagePage.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .where(and(eq(communityPage.artifactId, artifactId), activeActor(db, readerId), messageChannelReadableSql(db, readerId, channelColumns)));
}

export async function listReadablePageChannels(db: Database, artifactId: string, readerId: string) {
  return listReadablePageChannelsQuery(db, artifactId, readerId);
}

export async function getPageAccessContext(db: Database, artifactId: string, readerId: string) {
  const pageQuery = getReadableResourceQuery(db, artifactId, readerId, "artifactId");
  const channelsQuery = listReadablePageChannelsQuery(db, artifactId, readerId);
  const [pageRows, channels] = typeof db.batch === "function"
    ? await db.batch([pageQuery, channelsQuery])
    : await Promise.all([pageQuery, channelsQuery]);
  return { page: pageRows[0] ?? null, channels };
}

export async function getOwnedPage(db: Database, id: string, botId: string) {
  const [row] = await db.select().from(communityPage).where(and(eq(communityPage.id, id), eq(communityPage.botId, botId), activeActor(db, botId))).limit(1);
  return row ?? null;
}

export async function deleteOwnedPage(db: Database, id: string, botId: string) {
  const [row] = await db.delete(communityPage).where(and(eq(communityPage.id, id), eq(communityPage.botId, botId), activeActor(db, botId))).returning({ id: communityPage.id });
  return row ?? null;
}

export async function listOwnedPages(db: Database, botId: string, options: { limit?: number; cursor?: { createdAt: string; id: string } } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const owned = and(eq(communityPage.botId, botId), activeActor(db, botId));
  const [summary] = await db.select({ total: count() }).from(communityPage).where(owned);
  const cursor = options.cursor;
  const rows = await db.select({ id: communityPage.id, type: communityPage.type, title: communityPage.title, createdAt: communityPage.createdAt })
    .from(communityPage).where(and(owned, ...(cursor ? [or(lt(communityPage.createdAt, cursor.createdAt), and(eq(communityPage.createdAt, cursor.createdAt), lt(communityPage.id, cursor.id)))] : [])))
    .orderBy(desc(communityPage.createdAt), desc(communityPage.id)).limit(limit + 1);
  const selected = rows.slice(0, limit);
  const ids = selected.map(row => row.id);
  const counts = ids.length ? await db.select({ id: communityMessagePage.pageId, messageCount: count() }).from(communityMessagePage)
    .where(inArray(communityMessagePage.pageId, ids)).groupBy(communityMessagePage.pageId) : [];
  const messages = new Map(counts.map(row => [row.id, row.messageCount]));
  const last = selected.at(-1);
  return { total: summary?.total ?? 0, pages: selected.map(row => ({ ...row, messageCount: messages.get(row.id) ?? 0 })),
    ...(rows.length > limit && last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {}) };
}

const viewerTicket = z.strictObject({ userId: z.string().min(1), pageId: z.string().min(1), origin: z.url(), sourceMessageId: z.string().min(1) });
export async function createPageViewerTicket(db: Database, input: { hash: string; userId: string; pageId: string; origin: string; sourceMessageId: string; expiresAt: string; now: string }) {
  const identifier = `alook-page:${input.userId}`;
  const expired = db.select({ id: verification.id }).from(verification).where(and(eq(verification.identifier, identifier), lt(verification.expiresAt, input.now))).orderBy(asc(verification.expiresAt)).limit(32);
  const cleanup = db.delete(verification).where(inArray(verification.id, expired));
  const insert = db.insert(verification).values({ id: `alook-page:${input.hash}`, identifier, value: JSON.stringify({ userId: input.userId, pageId: input.pageId, origin: input.origin, sourceMessageId: input.sourceMessageId }), expiresAt: input.expiresAt, createdAt: input.now, updatedAt: input.now });
  if (typeof db.batch === "function") {
    await db.batch([cleanup, insert]);
  } else {
    await cleanup;
    await insert;
  }
}
export async function consumePageViewerTicket(db: Database, hash: string, origin: string, now: string) {
  const [row] = await db.delete(verification).where(and(eq(verification.id, `alook-page:${hash}`), gt(verification.expiresAt, now))).returning({ value: verification.value });
  if (!row) return null;
  let input: unknown; try { input = JSON.parse(row.value); } catch { return null; }
  const parsed = viewerTicket.safeParse(input);
  if (!parsed.success || parsed.data.origin !== origin) return null;
  const pageQuery = readablePageQuery(db, "id", parsed.data.pageId, parsed.data.userId, parsed.data.sourceMessageId);
  const userQuery = db.select({ id: user.id, name: user.name }).from(user).where(and(eq(user.id, parsed.data.userId), isNull(user.deletedAt))).limit(1);
  const [pageRows, userRows] = typeof db.batch === "function"
    ? await db.batch([pageQuery, userQuery])
    : await Promise.all([pageQuery, userQuery]);
  const page = pageRows.length === 1 ? pageRows[0]! : null;
  return page ? { page, userId: parsed.data.userId, user: userRows[0] ?? null } : null;
}
