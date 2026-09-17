import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { nanoid } from "nanoid";
import {
  communityMachine,
  communityMachineCredential,
} from "../../community-machine-schema";
import { communityMessage, communityServerMember } from "../../community-schema";
import {
  communityFunnelAnalyticsEvent,
  type CommunityFunnelAnalyticsEvent,
  type CommunityFunnelConversationType,
  type CommunityFunnelEventName,
} from "../../community-funnel-analytics-schema";
import { user } from "../../schema";
import type { Database } from "../../index";

const inviter = alias(user, "community_funnel_inviter");
const invitee = alias(user, "community_funnel_invitee");
const replyingBot = alias(user, "community_funnel_replying_bot");
const botOwner = alias(user, "community_funnel_bot_owner");

function eventProjection(input: {
  id: string;
  ownerUserId: string;
  eventName: CommunityFunnelEventName;
  conversationType?: CommunityFunnelConversationType;
  sourceId: string;
  dedupeKey: string;
  createdAt: string;
}) {
  return {
    id: sql<string>`${input.id}`.as("id"),
    ownerUserId: sql<string>`${input.ownerUserId}`.as("owner_user_id"),
    eventName: sql<CommunityFunnelEventName>`${input.eventName}`.as("event_name"),
    conversationType: sql<CommunityFunnelConversationType | null>`${input.conversationType ?? null}`.as("conversation_type"),
    sourceId: sql<string>`${input.sourceId}`.as("source_id"),
    dedupeKey: sql<string>`${input.dedupeKey}`.as("dedupe_key"),
    createdAt: sql<string>`${input.createdAt}`.as("created_at"),
    claimedAt: sql<string | null>`NULL`.as("claimed_at"),
  };
}

export function recordRuntimeConnectedStatement(db: Database, input: {
  ownerUserId: string;
  machineId: string;
  credentialHash: string;
  now?: string;
}) {
  const createdAt = input.now ?? new Date().toISOString();
  return db.insert(communityFunnelAnalyticsEvent).select(db.select(eventProjection({
    id: nanoid(),
    ownerUserId: input.ownerUserId,
    eventName: "runtime_connected",
    sourceId: input.credentialHash,
    dedupeKey: `runtime_connected:${input.credentialHash}`,
    createdAt,
  })).from(user).where(and(
    eq(user.id, input.ownerUserId),
    eq(user.isBot, false),
    isNull(user.deletedAt),
    exists(db.select({ id: communityMachine.id }).from(communityMachine).where(and(
      eq(communityMachine.id, input.machineId),
      eq(communityMachine.userId, input.ownerUserId),
      eq(communityMachine.status, "online"),
    ))),
    exists(db.select({ id: communityMachineCredential.id }).from(communityMachineCredential).where(and(
      eq(communityMachineCredential.machineId, input.machineId),
      eq(communityMachineCredential.userId, input.ownerUserId),
      eq(communityMachineCredential.credentialHash, input.credentialHash),
      isNull(communityMachineCredential.revokedAt),
    ))),
  ))).onConflictDoNothing();
}

export function recordFirstAgentReplyPersistedStatement(db: Database, input: {
  botUserId: string;
  messageId: string;
  conversationType: CommunityFunnelConversationType;
  now?: string;
}) {
  const createdAt = input.now ?? new Date().toISOString();
  return db.insert(communityFunnelAnalyticsEvent).select(db.select({
    id: sql<string>`${nanoid()}`.as("id"),
    ownerUserId: botOwner.id,
    eventName: sql<CommunityFunnelEventName>`${"first_agent_reply_persisted"}`.as("event_name"),
    conversationType: sql<CommunityFunnelConversationType>`${input.conversationType}`.as("conversation_type"),
    sourceId: sql<string>`${input.messageId}`.as("source_id"),
    dedupeKey: sql<string>`${"first_agent_reply_persisted:"} || ${botOwner.id}`.as("dedupe_key"),
    createdAt: sql<string>`${createdAt}`.as("created_at"),
    claimedAt: sql<string | null>`NULL`.as("claimed_at"),
  }).from(replyingBot).innerJoin(botOwner, and(
    eq(botOwner.id, replyingBot.ownerUserId),
    eq(botOwner.isBot, false),
    isNull(botOwner.deletedAt),
  )).where(and(
    eq(replyingBot.id, input.botUserId),
    eq(replyingBot.isBot, true),
    isNull(replyingBot.deletedAt),
    exists(db.select({ id: communityMessage.id }).from(communityMessage).where(and(
      eq(communityMessage.id, input.messageId),
      eq(communityMessage.authorId, input.botUserId),
      eq(communityMessage.type, "default"),
    ))),
  ))).onConflictDoNothing();
}

export async function recordFirstAgentReplyPersisted(db: Database, input: {
  botUserId: string;
  messageId: string;
  conversationType: CommunityFunnelConversationType;
  now?: string;
}) {
  const rows = await recordFirstAgentReplyPersistedStatement(db, input)
    .returning({ id: communityFunnelAnalyticsEvent.id });
  return rows.length === 1;
}

export function recordInvitedHumanJoinedStatement(db: Database, input: {
  ownerUserId: string;
  membershipId: string;
  invitedUserId: string;
  now?: string;
}) {
  const createdAt = input.now ?? new Date().toISOString();
  return db.insert(communityFunnelAnalyticsEvent).select(db.select(eventProjection({
    id: nanoid(),
    ownerUserId: input.ownerUserId,
    eventName: "invited_human_joined",
    sourceId: input.membershipId,
    dedupeKey: `invited_human_joined:${input.membershipId}`,
    createdAt,
  })).from(inviter).where(and(
    eq(inviter.id, input.ownerUserId),
    eq(inviter.isBot, false),
    isNull(inviter.deletedAt),
    exists(db.select({ id: communityServerMember.id }).from(communityServerMember).innerJoin(
      invitee,
      and(eq(invitee.id, communityServerMember.userId), eq(invitee.isBot, false), isNull(invitee.deletedAt)),
    ).where(and(
      eq(communityServerMember.id, input.membershipId),
      eq(communityServerMember.userId, input.invitedUserId),
    ))),
  ))).onConflictDoNothing();
}

export async function claimPendingEvents(db: Database, ownerUserId: string, now = new Date().toISOString()) {
  const rows = await db.update(communityFunnelAnalyticsEvent).set({ claimedAt: now }).where(and(
    eq(communityFunnelAnalyticsEvent.ownerUserId, ownerUserId),
    isNull(communityFunnelAnalyticsEvent.claimedAt),
  )).returning({
    eventName: communityFunnelAnalyticsEvent.eventName,
    conversationType: communityFunnelAnalyticsEvent.conversationType,
  });

  return rows.flatMap<CommunityFunnelAnalyticsEvent>((row) => {
    if (row.eventName === "runtime_connected") {
      return [{ event: "runtime_connected", surface: "community", connection_type: "local_daemon" }];
    }
    if (row.eventName === "first_agent_reply_persisted" && row.conversationType) {
      return [{ event: "first_agent_reply_persisted", surface: "community", conversation_type: row.conversationType }];
    }
    if (row.eventName === "invited_human_joined") {
      return [{ event: "invited_human_joined", surface: "community" }];
    }
    return [];
  });
}
