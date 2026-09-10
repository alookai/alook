import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
};

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
