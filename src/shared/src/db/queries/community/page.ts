import { and, asc, eq, exists, getTableColumns, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../index";
import { communityPage } from "../../page-schema";
import { communityChannel, communityMessage } from "../../community-schema";
import { user, verification } from "../../schema";
import { messageChannelReadableSql } from "./channel";

export function pageBindingStatement(db: Database, data: typeof communityPage.$inferInsert) {
  return db.insert(communityPage).select(db.select({
    id: sql<string>`${data.id}`.as("id"),
    artifactId: sql<string>`${data.artifactId}`.as("artifact_id"),
    messageId: communityMessage.id,
    botId: user.id,
    createdAt: sql<string>`${data.createdAt}`.as("created_at"),
  }).from(communityMessage)
    .innerJoin(user, eq(user.id, communityMessage.authorId))
    .where(and(
      eq(communityMessage.id, data.messageId),
      eq(communityMessage.authorId, data.botId),
      eq(user.isBot, true),
      isNull(user.deletedAt),
    )));
}

async function readablePage(db: Database, key: "id" | "artifactId", value: string, readerId: string) {
  const reader = db.select({ id: user.id }).from(user)
    .where(and(eq(user.id, readerId), isNull(user.deletedAt)));
  const [row] = await db.select({
    ...getTableColumns(communityPage),
    channelId: communityMessage.channelId,
    channelType: communityChannel.type,
  }).from(communityPage)
    .innerJoin(communityMessage, eq(communityMessage.id, communityPage.messageId))
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .where(and(
      eq(communityPage[key], value),
      exists(reader),
      messageChannelReadableSql(db, readerId, {
        id: communityChannel.id,
        type: communityChannel.type,
        serverId: communityChannel.serverId,
        parentChannelId: communityChannel.parentChannelId,
      }),
    )).limit(1);
  return row ?? null;
}

export function getReadablePage(db: Database, id: string, readerId: string) {
  return readablePage(db, "id", id, readerId);
}

export function getReadablePageForArtifact(db: Database, artifactId: string, readerId: string) {
  return readablePage(db, "artifactId", artifactId, readerId);
}

const viewerTicket = z.strictObject({ userId: z.string().min(1), pageId: z.string().min(1), origin: z.url() });

export async function createPageViewerTicket(db: Database, input: {
  hash: string; userId: string; pageId: string; origin: string; expiresAt: string; now: string;
}) {
  const identifier = `alook-page:${input.userId}`;
  const expired = db.select({ id: verification.id }).from(verification)
    .where(and(eq(verification.identifier, identifier), lt(verification.expiresAt, input.now)))
    .orderBy(asc(verification.expiresAt)).limit(32);
  await db.delete(verification).where(inArray(verification.id, expired));
  await db.insert(verification).values({
    id: `alook-page:${input.hash}`,
    identifier,
    value: JSON.stringify({ userId: input.userId, pageId: input.pageId, origin: input.origin }),
    expiresAt: input.expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function consumePageViewerTicket(db: Database, hash: string, origin: string, now: string) {
  const [row] = await db.delete(verification).where(and(
    eq(verification.id, `alook-page:${hash}`), gt(verification.expiresAt, now),
  )).returning({ value: verification.value });
  if (!row) return null;
  let input: unknown;
  try { input = JSON.parse(row.value); } catch { return null; }
  const parsed = viewerTicket.safeParse(input);
  if (!parsed.success || parsed.data.origin !== origin) return null;
  const page = await getReadablePage(db, parsed.data.pageId, parsed.data.userId);
  return page ? { page, userId: parsed.data.userId } : null;
}
