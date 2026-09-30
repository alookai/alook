import { and, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "../index";
import {
  billingAnalyticsConsent,
  billingPrice,
  billingPurchaseDelivery,
  userBilling,
  type BillingAnalyticsConsentDecision,
  type BillingPurchaseDeliveryStatus,
  type BillingPurchaseType,
} from "../billing-schema";
import { productPlan, productPlanEntitlement, userProductPlan } from "../product-plan-schema";
import { user } from "../schema";
import {
  assignUserPlanBuilder, botsMaxForPlanSql, nonFounderCondition,
  reconcileOwnerOnlineMachinesBuilders, machinesMaxForPlanSql, type DisconnectedMachine,
  reconcileOwnerActiveBotsBuilder, resolveBotsMaxForUser,
} from "./product-plan";

export type BillingRow = typeof userBilling.$inferSelect;
export type BillingPatch = Partial<Pick<BillingRow,
  "customerId" | "subscriptionId" | "subscription" | "checkoutAttempt"
>>;

function billingOwnerCondition(db: Database, userId: string, allowFounder = false) {
  return and(allowFounder ? undefined : nonFounderCondition(db, userId), exists(db.select({ id: user.id }).from(user).where(and(
    eq(user.id, userId), eq(user.isBot, false), isNull(user.deletedAt),
  ))));
}

export async function getBilling(db: Database, userId: string) {
  const rows = await db.select().from(userBilling).where(eq(userBilling.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getBillingByCustomer(db: Database, customerId: string) {
  const rows = await db.select().from(userBilling).where(eq(userBilling.customerId, customerId)).limit(1);
  return rows[0] ?? null;
}

export async function recordAnalyticsConsent(
  db: Database,
  userId: string,
  decision: BillingAnalyticsConsentDecision,
  sourceVersion: number,
) {
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion <= 0) {
    throw new Error("ANALYTICS_CONSENT_SOURCE_VERSION_INVALID");
  }
  const now = new Date().toISOString();
  const rows = await db.insert(billingAnalyticsConsent).values({
    userId,
    decision,
    sourceVersion,
    revision: 1,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: billingAnalyticsConsent.userId,
    set: {
      decision,
      sourceVersion,
      revision: sql`CASE
        WHEN ${billingAnalyticsConsent.decision} = ${decision} THEN ${billingAnalyticsConsent.revision}
        ELSE ${billingAnalyticsConsent.revision} + 1
      END`,
      updatedAt: now,
    },
    setWhere: decision === "denied"
      ? or(
          lt(billingAnalyticsConsent.sourceVersion, sourceVersion),
          and(
            eq(billingAnalyticsConsent.sourceVersion, sourceVersion),
            eq(billingAnalyticsConsent.decision, "granted"),
          ),
        )
      : lt(billingAnalyticsConsent.sourceVersion, sourceVersion),
  }).returning();
  if (rows[0]) return rows[0];
  const current = await getAnalyticsConsent(db, userId);
  if (!current) throw new Error("ANALYTICS_CONSENT_WRITE_LOST");
  return current;
}

export async function getAnalyticsConsent(db: Database, userId: string) {
  const rows = await db.select().from(billingAnalyticsConsent)
    .where(eq(billingAnalyticsConsent.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function claimPurchaseDelivery(db: Database, invoiceId: string, userId: string) {
  const rows = await db.insert(billingPurchaseDelivery).values({
    invoiceId,
    userId,
    status: "claimed",
    reason: "delivery_in_progress",
  }).onConflictDoNothing().returning({ invoiceId: billingPurchaseDelivery.invoiceId });
  return rows.length === 1;
}

export async function finalizePurchaseDelivery(
  db: Database,
  invoiceId: string,
  result: {
    status: Exclude<BillingPurchaseDeliveryStatus, "claimed">;
    reason: string;
    purchaseType?: BillingPurchaseType;
    currency?: string;
    valueMinor?: number;
    planId?: string;
    validationJson?: string;
  },
) {
  const rows = await db.update(billingPurchaseDelivery).set({
    ...result,
    finalizedAt: new Date().toISOString(),
  }).where(and(
    eq(billingPurchaseDelivery.invoiceId, invoiceId),
    eq(billingPurchaseDelivery.status, "claimed"),
  )).returning({ invoiceId: billingPurchaseDelivery.invoiceId });
  return rows.length === 1;
}

export async function ensureBilling(db: Database, userId: string, founderAcknowledged = false) {
  const now = new Date().toISOString();
  await db.insert(userBilling).select(db.select({
    userId: user.id,
    customerId: sql<string | null>`NULL`.as("customer_id"),
    subscriptionId: sql<string | null>`NULL`.as("subscription_id"),
    subscription: sql<null>`NULL`.as("subscription_json"),
    revision: sql<number>`0`.as("revision"),
    applyToken: sql<string | null>`NULL`.as("apply_token"),
    checkoutAttempt: sql<null>`NULL`.as("checkout_attempt_json"),
    updatedAt: sql<string>`${now}`.as("updated_at"),
  }).from(user).where(and(
    eq(user.id, userId), eq(user.isBot, false), isNull(user.deletedAt),
    founderAcknowledged ? undefined : nonFounderCondition(db, userId),
  ))).onConflictDoNothing();
  return getBilling(db, userId);
}

export async function listPrices(db: Database, includeDisabled = false) {
  const machineEntitlement = alias(productPlanEntitlement, "machine_entitlement");
  return db.select({
    priceId: billingPrice.priceId,
    portalConfigurationId: billingPrice.portalConfigurationId,
    botLimit: productPlanEntitlement.valueJson,
    machineLimit: machineEntitlement.valueJson,
    planId: productPlan.id,
    displayName: productPlan.displayName,
    sortOrder: productPlan.sortOrder,
  }).from(billingPrice).innerJoin(productPlan, eq(productPlan.id, billingPrice.planId))
    .innerJoin(productPlanEntitlement, and(eq(productPlanEntitlement.planId, productPlan.id), eq(productPlanEntitlement.entitlementKey, "bots.max")))
    .innerJoin(machineEntitlement, and(eq(machineEntitlement.planId, productPlan.id), eq(machineEntitlement.entitlementKey, "machines.max")))
    .where(and(includeDisabled ? undefined : eq(billingPrice.enabled, true), eq(productPlan.isActive, true), eq(productPlan.isDefault, false)))
    .orderBy(productPlan.sortOrder);
}

export async function getDefaultPlan(db: Database) {
  const rows = await db.select({ id: productPlan.id, displayName: productPlan.displayName })
    .from(productPlan).where(and(eq(productPlan.isDefault, true), eq(productPlan.isActive, true))).limit(1);
  if (!rows[0]) throw new Error("DEFAULT_PLAN_UNAVAILABLE");
  return rows[0];
}

export async function getDefaultPlanOffer(db: Database) {
  const machineEntitlement = alias(productPlanEntitlement, "machine_entitlement");
  const rows = await db.select({
    plan: { id: productPlan.id, displayName: productPlan.displayName },
    botLimit: productPlanEntitlement.valueJson,
    machineLimit: machineEntitlement.valueJson,
  }).from(productPlan).innerJoin(productPlanEntitlement, and(
    eq(productPlanEntitlement.planId, productPlan.id),
    eq(productPlanEntitlement.entitlementKey, "bots.max"),
  )).innerJoin(machineEntitlement, and(eq(machineEntitlement.planId, productPlan.id), eq(machineEntitlement.entitlementKey, "machines.max"))).where(and(eq(productPlan.isDefault, true), eq(productPlan.isActive, true))).limit(1);
  if (!rows[0]) throw new Error("DEFAULT_PLAN_UNAVAILABLE");
  return rows[0];
}

export async function updateBilling(db: Database, current: BillingRow, patch: BillingPatch, founderAcknowledged = false) {
  const rows = await db.update(userBilling).set({
    ...patch,
    revision: current.revision + 1,
    applyToken: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(userBilling.userId, current.userId), eq(userBilling.revision, current.revision),
    billingOwnerCondition(db, current.userId, founderAcknowledged || current.checkoutAttempt?.founderAcknowledged === true),
  )).returning();
  return rows[0] ?? null;
}

export async function applyBillingPlan(
  db: Database,
  current: BillingRow,
  patch: BillingPatch,
  planId: string,
  founderAttemptId?: string,
): Promise<{ applied: boolean; deactivatedBotIds: string[]; disconnectedMachines: DisconnectedMachine[] }> {
  const founderAttempt = current.checkoutAttempt;
  if (founderAttemptId && (!founderAttempt?.founderAcknowledged || founderAttempt.id !== founderAttemptId
    || patch.checkoutAttempt !== null || !patch.subscriptionId || !patch.subscription)) {
    return { applied: false, deactivatedBotIds: [], disconnectedMachines: [] };
  }
  const machineEntitlement = alias(productPlanEntitlement, "machine_entitlement");
  const available = await db.select({ value: productPlanEntitlement.valueJson, machineValue: machineEntitlement.valueJson }).from(productPlan)
    .innerJoin(productPlanEntitlement, and(eq(productPlanEntitlement.planId, productPlan.id), eq(productPlanEntitlement.entitlementKey, "bots.max")))
    .innerJoin(machineEntitlement, and(eq(machineEntitlement.planId, productPlan.id), eq(machineEntitlement.entitlementKey, "machines.max")))
    .where(and(eq(productPlan.id, planId), eq(productPlan.isActive, true))).limit(1);
  if (typeof available[0]?.value !== "number" || !Number.isInteger(available[0].value) || available[0].value < 0) {
    throw new Error("BILLING_PLAN_UNAVAILABLE");
  }
  if (typeof available[0]?.machineValue !== "number" || !Number.isInteger(available[0].machineValue) || available[0].machineValue < 0) throw new Error("BILLING_PLAN_UNAVAILABLE");
  const token = crypto.randomUUID();
  const guard = exists(db.select({ one: sql<number>`1` }).from(userBilling).where(and(
    eq(userBilling.userId, current.userId), eq(userBilling.applyToken, token),
      billingOwnerCondition(db, current.userId, true),
  )));
  const projection = db.update(userBilling).set({
    ...patch, revision: current.revision + 1, applyToken: token,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(userBilling.userId, current.userId), eq(userBilling.revision, current.revision),
    billingOwnerCondition(db, current.userId, Boolean(founderAttemptId)),
    founderAttemptId ? and(
      eq(userBilling.checkoutAttempt, founderAttempt!),
      exists(db.select({ id: billingPrice.priceId }).from(billingPrice).where(and(
        eq(billingPrice.priceId, founderAttempt!.priceId), eq(billingPrice.planId, planId),
      ))),
    ) : undefined,
    exists(db.select({ id: machineEntitlement.planId }).from(machineEntitlement).where(and(
      eq(machineEntitlement.planId, planId), eq(machineEntitlement.entitlementKey, "machines.max"),
      sql`json_type(${machineEntitlement.valueJson}) = 'integer' AND CAST(${machineEntitlement.valueJson} AS INTEGER) >= 0`,
    ))),
    exists(db.select({ id: productPlan.id }).from(productPlan).innerJoin(productPlanEntitlement, and(
      eq(productPlanEntitlement.planId, productPlan.id), eq(productPlanEntitlement.entitlementKey, "bots.max"),
    )).where(and(eq(productPlan.id, planId), eq(productPlan.isActive, true),
      sql`json_type(${productPlanEntitlement.valueJson}) = 'integer' AND CAST(${productPlanEntitlement.valueJson} AS INTEGER) >= 0`,
    ))),
  )).returning({ userId: userBilling.userId });
  const assignment = assignUserPlanBuilder(db, current.userId, planId, guard);
  const reconcile = reconcileOwnerActiveBotsBuilder(db, current.userId, botsMaxForPlanSql(planId), guard);
  const machines = reconcileOwnerOnlineMachinesBuilders(db, current.userId, machinesMaxForPlanSql(planId), guard);
  if (founderAttemptId) {
    const removeFounder = db.update(userProductPlan).set({ isFounder: false })
      .where(and(eq(userProductPlan.userId, current.userId), eq(userProductPlan.isFounder, true), guard));
    const results = await db.batch([projection, removeFounder, assignment, reconcile, ...machines]);
    return { applied: results[0].length === 1, deactivatedBotIds: results[3].map((row) => row.botId), disconnectedMachines: results[4] };
  }
  const results = await db.batch([projection, assignment, reconcile, ...machines]);
  return { applied: results[0].length === 1, deactivatedBotIds: results[2].map((row) => row.botId), disconnectedMachines: results[3] };
}

export { resolveBotsMaxForUser as getEffectivePlan };
