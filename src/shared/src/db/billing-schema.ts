import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./schema";
import { productPlan } from "./product-plan-schema";
import type { BillingSubscription } from "../billing";

export type CheckoutAttempt = {
  id: string;
  priceId: string;
  email: string;
  origin: string;
  startedAt: number;
  sessionId: string | null;
  founderAcknowledged?: boolean;
  analytics?: {
    clientId: string;
    sessionId: string;
    consentRevision: number;
  };
  analyticsSkipReason?: "stale_consent_proof";
};

export type BillingAnalyticsConsentDecision = "granted" | "denied";
export type BillingPurchaseDeliveryStatus = "claimed" | "sent" | "failed" | "skipped";
export type BillingPurchaseType = "initial_subscription" | "renewal" | "upgrade" | "other";

export const billingPrice = sqliteTable("billing_price", {
  priceId: text("price_id").primaryKey(),
  planId: text("plan_id").notNull().references(() => productPlan.id, { onDelete: "restrict" }),
  portalConfigurationId: text("portal_configuration_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const userBilling = sqliteTable("user_billing", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  customerId: text("customer_id"),
  subscriptionId: text("subscription_id"),
  subscription: text("subscription_json", { mode: "json" }).$type<BillingSubscription>(),
  revision: integer("revision").notNull().default(0),
  applyToken: text("apply_token"),
  checkoutAttempt: text("checkout_attempt_json", { mode: "json" }).$type<CheckoutAttempt>(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (t) => [
  uniqueIndex("uq_user_billing_customer").on(t.customerId),
  uniqueIndex("uq_user_billing_subscription").on(t.subscriptionId),
]);

export const billingAnalyticsConsent = sqliteTable("billing_analytics_consent", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  decision: text("decision").$type<BillingAnalyticsConsentDecision>().notNull(),
  sourceVersion: integer("source_version").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

export const billingPurchaseDelivery = sqliteTable("billing_purchase_delivery", {
  invoiceId: text("invoice_id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  status: text("status").$type<BillingPurchaseDeliveryStatus>().notNull(),
  reason: text("reason").notNull(),
  purchaseType: text("purchase_type").$type<BillingPurchaseType>(),
  currency: text("currency"),
  valueMinor: integer("value_minor"),
  planId: text("plan_id"),
  validationJson: text("validation_json"),
  claimedAt: text("claimed_at").notNull().$defaultFn(() => new Date().toISOString()),
  finalizedAt: text("finalized_at"),
}, (t) => [
  index("idx_billing_purchase_delivery_user_claimed").on(t.userId, t.claimedAt),
]);
