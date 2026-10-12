import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { communityChannel, communityServerInvite, communityMessage, communityServer } from "../../community-schema";
import { user } from "../../schema";
import { productAnalyticsEvent, type ProductAnalyticsDeliveryStatus } from "../../product-analytics-schema";
import type { Database } from "../../index";

export async function getOwnedServer(db: Database, actorUserId: string, serverId: string) {
  const rows = await db.select({ id: communityServer.id }).from(communityServer).where(and(
    eq(communityServer.id, serverId), eq(communityServer.ownerId, actorUserId),
  )).limit(1);
  return rows[0] ?? null;
}

export async function getInviteSource(db: Database, token: string) {
  const rows = await db.select({
    id: communityServerInvite.id, serverId: communityServerInvite.serverId, createdBy: communityServerInvite.createdBy,
  }).from(communityServerInvite).innerJoin(communityServer, eq(communityServer.id, communityServerInvite.serverId))
    .where(eq(communityServerInvite.token, token)).limit(1);
  return rows[0] ?? null;
}

export async function recordEvent(db: Database, input: Omit<typeof productAnalyticsEvent.$inferInsert,
  "id" | "deliveryStatus" | "deliveryReason" | "attemptedAt">) {
  const rows = await db.insert(productAnalyticsEvent).values({ ...input, id: nanoid() }).onConflictDoNothing().returning();
  if (rows[0]) return { row: rows[0], inserted: true };
  const existing = await db.select().from(productAnalyticsEvent)
    .where(and(eq(productAnalyticsEvent.dedupeKey, input.dedupeKey),
      input.actorUserId ? eq(productAnalyticsEvent.actorUserId, input.actorUserId) : isNull(productAnalyticsEvent.actorUserId),
      input.serverId ? eq(productAnalyticsEvent.serverId, input.serverId) : isNull(productAnalyticsEvent.serverId),
    )).limit(1);
  return existing[0] ? { row: existing[0], inserted: false } : null;
}

export async function recordFirstHumanMessage(db: Database, actorUserId: string, serverId: string, identity: { clientId: string; sessionId: string }, messageId: string) {
  const entered = await db.select().from(productAnalyticsEvent).where(and(
    eq(productAnalyticsEvent.actorUserId, actorUserId), eq(productAnalyticsEvent.serverId, serverId),
    eq(productAnalyticsEvent.eventName, "onboarding_enter_clicked"),
  )).limit(1);
  const entry = entered[0];
  if (!entry) return null;
  const messages = await db.select({ id: communityMessage.id, createdAt: communityMessage.createdAt })
    .from(communityMessage)
    .innerJoin(communityChannel, eq(communityChannel.id, communityMessage.channelId))
    .innerJoin(user, eq(user.id, communityMessage.authorId))
    .where(and(eq(communityMessage.authorId, actorUserId), eq(communityChannel.serverId, serverId),
      gte(communityMessage.createdAt, entry.createdAt), eq(communityMessage.type, "default"), eq(user.isBot, false), isNull(user.deletedAt)))
    .orderBy(asc(communityMessage.createdAt), asc(communityMessage.id)).limit(1);
  const message = messages[0];
  if (!message || message.id !== messageId) return null;
  return recordEvent(db, {
    eventName: "onboarding_first_message", actorUserId, serverId, sourceId: message.id,
    dedupeKey: `onboarding-first-message:${actorUserId}:${serverId}`,
    clientId: identity.clientId, sessionId: identity.sessionId, createdAt: message.createdAt,
  });
}

export async function claimDelivery(db: Database, id: string) {
  const rows = await db.update(productAnalyticsEvent).set({
    deliveryStatus: "sending", attemptedAt: new Date().toISOString(),
  }).where(and(eq(productAnalyticsEvent.id, id), eq(productAnalyticsEvent.deliveryStatus, "pending"))).returning();
  return rows[0] ?? null;
}

export async function finishDelivery(db: Database, id: string, deliveryStatus: ProductAnalyticsDeliveryStatus, deliveryReason: string) {
  await db.update(productAnalyticsEvent).set({ deliveryStatus, deliveryReason })
    .where(and(eq(productAnalyticsEvent.id, id), eq(productAnalyticsEvent.deliveryStatus, "sending")));
}

export async function claimSignupSession(db: Database, actorUserId: string, sessionId: string) {
  const claimed = await db.update(productAnalyticsEvent).set({ sourceId: sessionId })
    .where(and(eq(productAnalyticsEvent.actorUserId, actorUserId),
      eq(productAnalyticsEvent.eventName, "sign_up"), isNull(productAnalyticsEvent.sourceId))).returning();
  if (claimed[0]) return true;
  const previous = await db.select({ id: productAnalyticsEvent.id }).from(productAnalyticsEvent)
    .where(and(eq(productAnalyticsEvent.actorUserId, actorUserId),
      eq(productAnalyticsEvent.eventName, "sign_up"), eq(productAnalyticsEvent.sourceId, sessionId))).limit(1);
  return previous.length > 0;
}

export async function notePendingReason(db: Database, id: string, deliveryReason: string) {
  await db.update(productAnalyticsEvent).set({ deliveryReason })
    .where(and(eq(productAnalyticsEvent.id, id), eq(productAnalyticsEvent.deliveryStatus, "pending")));
}
