import { and, count, eq, exists, gt, inArray, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { user } from "../schema";
import { communityBotBinding } from "../community-machine-schema";
import {
  productPlan,
  productPlanEntitlement,
  userProductPlan,
} from "../product-plan-schema";
import type { Database } from "../index";
import {
  BOTS_MAX_ENTITLEMENT_KEY,
  EntitlementValueSchema,
  NonNegativeIntegerEntitlementSchema,
  type BotCapacitySummary,
  type EntitlementValue,
  type ResolvedProductPlan,
} from "../../product-entitlements";

export class ProductEntitlementUnavailableError extends Error {
  constructor(
    public readonly entitlementKey: string,
    public readonly reason: "plan_unavailable" | "entitlement_missing" | "entitlement_malformed",
  ) {
    super(`product entitlement unavailable: ${entitlementKey} (${reason})`);
    this.name = "ProductEntitlementUnavailableError";
  }
}

type StoredEntitlement = {
  planId: string;
  displayName: string;
  entitlementKey: string | null;
  value: unknown;
};

async function resolveStoredEntitlementForUser(
  db: Database,
  userId: string,
  entitlementKey: string,
): Promise<StoredEntitlement> {
  const rows = await db
    .select({
      planId: productPlan.id,
      displayName: productPlan.displayName,
      entitlementKey: productPlanEntitlement.entitlementKey,
      value: productPlanEntitlement.valueJson,
    })
    .from(productPlan)
    .leftJoin(userProductPlan, eq(userProductPlan.userId, userId))
    .leftJoin(
      productPlanEntitlement,
      and(
        eq(productPlanEntitlement.planId, productPlan.id),
        eq(productPlanEntitlement.entitlementKey, entitlementKey),
      ),
    )
    .where(
      and(
        eq(productPlan.isActive, true),
        or(
          eq(productPlan.id, userProductPlan.planId),
          and(isNull(userProductPlan.planId), eq(productPlan.isDefault, true)),
        ),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "plan_unavailable");
  }
  if (row.entitlementKey === null) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "entitlement_missing");
  }
  return row;
}

async function resolveStoredEntitlementForPlan(
  db: Database,
  planId: string,
  entitlementKey: string,
): Promise<StoredEntitlement> {
  const rows = await db
    .select({
      planId: productPlan.id,
      displayName: productPlan.displayName,
      entitlementKey: productPlanEntitlement.entitlementKey,
      value: productPlanEntitlement.valueJson,
    })
    .from(productPlan)
    .leftJoin(
      productPlanEntitlement,
      and(
        eq(productPlanEntitlement.planId, productPlan.id),
        eq(productPlanEntitlement.entitlementKey, entitlementKey),
      ),
    )
    .where(and(eq(productPlan.id, planId), eq(productPlan.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "plan_unavailable");
  }
  if (row.entitlementKey === null) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "entitlement_missing");
  }
  return row;
}

function parseStoredEntitlement<T>(
  row: StoredEntitlement,
  entitlementKey: string,
  schema: z.ZodType<T>,
): { plan: ResolvedProductPlan; value: T } {
  const parsed = schema.safeParse(row.value);
  if (!parsed.success) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "entitlement_malformed");
  }
  return {
    plan: { id: row.planId, displayName: row.displayName },
    value: parsed.data,
  };
}

export async function resolveEntitlementForUser<T>(
  db: Database,
  userId: string,
  entitlementKey: string,
  schema: z.ZodType<T>,
): Promise<{ plan: ResolvedProductPlan; value: T }> {
  return parseStoredEntitlement(
    await resolveStoredEntitlementForUser(db, userId, entitlementKey),
    entitlementKey,
    schema,
  );
}

export async function resolveBotsMaxForUser(
  db: Database,
  userId: string,
): Promise<{ plan: ResolvedProductPlan; value: number }> {
  return resolveEntitlementForUser(
    db,
    userId,
    BOTS_MAX_ENTITLEMENT_KEY,
    NonNegativeIntegerEntitlementSchema,
  );
}

export async function getBotCapacitySummary(
  db: Database,
  ownerUserId: string,
): Promise<BotCapacitySummary> {
  const [{ plan, value: limit }, counts] = await Promise.all([
    resolveBotsMaxForUser(db, ownerUserId),
    db
      .select({
        ownedCount: count(),
        activeCount: sql<number>`COALESCE(SUM(CASE WHEN ${communityBotBinding.isActive} = 1 THEN 1 ELSE 0 END), 0)`,
      })
      .from(user)
      .innerJoin(communityBotBinding, eq(communityBotBinding.userId, user.id))
      .where(
        and(
          eq(user.ownerUserId, ownerUserId),
          eq(user.isBot, true),
          isNull(user.deletedAt),
        ),
      ),
  ]);
  return {
    plan,
    limit,
    ownedCount: counts[0]?.ownedCount ?? 0,
    activeCount: counts[0]?.activeCount ?? 0,
  };
}

function reconcileActiveBotsBuilder(
  db: Database,
  ownerCondition: SQL<unknown>,
  botsMax: number | SQL<number>,
) {
  const ranked = db.$with("ranked_active_bots").as(
    db
      .select({
        botId: communityBotBinding.userId,
        activeRank: sql<number>`ROW_NUMBER() OVER (
          PARTITION BY ${user.ownerUserId}
          ORDER BY ${user.createdAt} ASC, ${user.id} ASC
        )`.as("active_rank"),
      })
      .from(communityBotBinding)
      .innerJoin(user, eq(user.id, communityBotBinding.userId))
      .where(
        and(
          eq(communityBotBinding.isActive, true),
          eq(user.isBot, true),
          isNull(user.deletedAt),
          ownerCondition,
        ),
      ),
  );
  const overflow = db
    .with(ranked)
    .select({ botId: ranked.botId })
    .from(ranked)
    .where(gt(ranked.activeRank, botsMax));
  return db
    .update(communityBotBinding)
    .set({ isActive: false })
    .where(inArray(communityBotBinding.userId, overflow))
    .returning({ botId: communityBotBinding.userId });
}

export function reconcileOwnerActiveBotsBuilder(
  db: Database,
  ownerUserId: string,
  botsMax: number | SQL<number>,
) {
  return reconcileActiveBotsBuilder(db, eq(user.ownerUserId, ownerUserId), botsMax);
}

function reconcilePlanActiveBotsBuilder(
  db: Database,
  planId: string,
  botsMax: number,
) {
  const ownerHasExplicitPlan = exists(
    db
      .select({ one: sql<number>`1` })
      .from(userProductPlan)
      .where(
        and(
          eq(userProductPlan.userId, user.ownerUserId),
          eq(userProductPlan.planId, planId),
        ),
      ),
  );
  const targetIsDefault = exists(
    db
      .select({ one: sql<number>`1` })
      .from(productPlan)
      .where(
        and(
          eq(productPlan.id, planId),
          eq(productPlan.isActive, true),
          eq(productPlan.isDefault, true),
        ),
      ),
  );
  const ownerHasNoAssignment = notExists(
    db
      .select({ one: sql<number>`1` })
      .from(userProductPlan)
      .where(eq(userProductPlan.userId, user.ownerUserId)),
  );
  return reconcileActiveBotsBuilder(
    db,
    or(ownerHasExplicitPlan, and(targetIsDefault, ownerHasNoAssignment))!,
    botsMax,
  );
}

function botsMaxForPlanSql(planId: string): SQL<number> {
  return sql<number>`COALESCE((
    SELECT CAST(entitlement.value_json AS INTEGER)
    FROM product_plan_entitlement entitlement
    INNER JOIN product_plan plan ON plan.id = entitlement.plan_id
    WHERE plan.id = ${planId}
      AND plan.is_active = 1
      AND entitlement.entitlement_key = ${BOTS_MAX_ENTITLEMENT_KEY}
      AND json_type(entitlement.value_json) = 'integer'
      AND CAST(entitlement.value_json AS INTEGER) >= 0
    LIMIT 1
  ), 0)`;
}

export async function assignUserPlan(
  db: Database,
  userId: string,
  planId: string,
): Promise<{ plan: ResolvedProductPlan; limit: number; deactivatedBotIds: string[] }> {
  const resolved = parseStoredEntitlement(
    await resolveStoredEntitlementForPlan(db, planId, BOTS_MAX_ENTITLEMENT_KEY),
    BOTS_MAX_ENTITLEMENT_KEY,
    NonNegativeIntegerEntitlementSchema,
  );
  const now = new Date().toISOString();
  const assign = db
    .insert(userProductPlan)
    .values({ userId, planId, assignedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: userProductPlan.userId,
      set: { planId, updatedAt: now },
    });
  const reconcile = reconcileOwnerActiveBotsBuilder(db, userId, botsMaxForPlanSql(planId));
  const results = await db.batch([assign, reconcile] as any) as unknown as [unknown, Array<{ botId: string }>];
  return {
    plan: resolved.plan,
    limit: resolved.value,
    deactivatedBotIds: results[1].map((row) => row.botId),
  };
}

export async function setPlanEntitlement(
  db: Database,
  planId: string,
  entitlementKey: string,
  value: EntitlementValue,
): Promise<{ deactivatedBotIds: string[] }> {
  const parsedValue = EntitlementValueSchema.parse(value);
  const planRows = await db
    .select({ id: productPlan.id })
    .from(productPlan)
    .where(and(eq(productPlan.id, planId), eq(productPlan.isActive, true)))
    .limit(1);
  if (!planRows[0]) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "plan_unavailable");
  }
  const now = new Date().toISOString();
  const write = db
    .insert(productPlanEntitlement)
    .values({ planId, entitlementKey, valueJson: parsedValue, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [productPlanEntitlement.planId, productPlanEntitlement.entitlementKey],
      set: { valueJson: parsedValue, updatedAt: now },
    });
  if (entitlementKey !== BOTS_MAX_ENTITLEMENT_KEY) {
    await write;
    return { deactivatedBotIds: [] };
  }
  const botsMax = NonNegativeIntegerEntitlementSchema.safeParse(parsedValue);
  if (!botsMax.success) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "entitlement_malformed");
  }
  const reconcile = reconcilePlanActiveBotsBuilder(db, planId, botsMax.data);
  const results = await db.batch([write, reconcile] as any) as unknown as [unknown, Array<{ botId: string }>];
  return { deactivatedBotIds: results[1].map((row) => row.botId) };
}
