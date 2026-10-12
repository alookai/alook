import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema";
import { communityServer } from "./community-schema";

export const PRODUCT_ANALYTICS_EVENTS = [
  "landing_cta_clicked",
  "login_page_view",
  "sign_up",
  "sign_in_success",
  "sign_in_failed",
  "onboarding_enter_clicked",
  "onboarding_first_message",
  "invitation_link_visit",
] as const;

export type ProductAnalyticsEventName = typeof PRODUCT_ANALYTICS_EVENTS[number];
export type ProductAnalyticsDeliveryStatus = "pending" | "sending" | "accepted" | "failed" | "uncertain" | "denied";

export const productAnalyticsEvent = sqliteTable("product_analytics_event", {
  id: text("id").primaryKey(),
  eventName: text("event_name").notNull().$type<ProductAnalyticsEventName>(),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "cascade" }),
  serverId: text("server_id").references(() => communityServer.id, { onDelete: "cascade" }),
  sourceId: text("source_id"),
  dedupeKey: text("dedupe_key").notNull(),
  clientId: text("client_id").notNull(),
  sessionId: text("session_id").notNull(),
  method: text("method"),
  accountKind: text("account_kind").$type<"new" | "existing">(),
  ctaName: text("cta_name"),
  failureStage: text("failure_stage").$type<"send_code" | "verify_code" | "social_start" | "provider_callback">(),
  createdAt: text("created_at").notNull(),
  deliveryStatus: text("delivery_status").notNull().default("pending").$type<ProductAnalyticsDeliveryStatus>(),
  deliveryReason: text("delivery_reason"),
  attemptedAt: text("attempted_at"),
}, (t) => [
  uniqueIndex("uq_product_analytics_dedupe").on(t.dedupeKey),
  index("idx_product_analytics_actor_server_event").on(t.actorUserId, t.serverId, t.eventName),
]);

export type ProductAnalyticsEvent = typeof productAnalyticsEvent.$inferSelect;
