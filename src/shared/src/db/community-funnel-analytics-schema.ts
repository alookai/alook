import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema";

export const COMMUNITY_FUNNEL_EVENT_NAMES = [
  "runtime_connected",
  "first_agent_reply_persisted",
  "invited_human_joined",
] as const;

export const COMMUNITY_FUNNEL_CONVERSATION_TYPES = [
  "dm",
  "channel",
  "thread",
] as const;

export type CommunityFunnelEventName = typeof COMMUNITY_FUNNEL_EVENT_NAMES[number];
export type CommunityFunnelConversationType = typeof COMMUNITY_FUNNEL_CONVERSATION_TYPES[number];

export type CommunityFunnelAnalyticsEvent =
  | {
      event: "runtime_connected";
      surface: "community";
      connection_type: "local_daemon";
    }
  | {
      event: "first_agent_reply_persisted";
      surface: "community";
      conversation_type: CommunityFunnelConversationType;
    }
  | {
      event: "invited_human_joined";
      surface: "community";
    };

export const communityFunnelAnalyticsEvent = sqliteTable("community_funnel_analytics_event", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  eventName: text("event_name").notNull().$type<CommunityFunnelEventName>(),
  conversationType: text("conversation_type").$type<CommunityFunnelConversationType>(),
  sourceId: text("source_id").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  claimedAt: text("claimed_at"),
}, (t) => [
  uniqueIndex("uq_community_funnel_analytics_dedupe").on(t.dedupeKey),
  index("idx_community_funnel_analytics_owner_claimed_created")
    .on(t.ownerUserId, t.claimedAt, t.createdAt),
]);
