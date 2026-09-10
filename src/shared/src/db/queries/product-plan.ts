import { and, count, eq, exists, gt, inArray, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { user } from "../schema";
import { communityBotBinding, communityMachine, communityMachineCredential, communityAgentRunnerKey } from "../community-machine-schema";
import {
  productPlan,
  productPlanEntitlement,
  userProductPlan,
} from "../product-plan-schema";
import type { Database } from "../index";
import {
  BOTS_MAX_ENTITLEMENT_KEY,
  MACHINES_MAX_ENTITLEMENT_KEY,
  type MachineCapacitySummary,
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
  isFounder?: boolean | null;
};

async function resolveStoredEntitlementForUser(
  db: Database,
  userId: string,
  entitlementKey: string,
): Promise<StoredEntitlement> {
  const rows = await db
    .select({
      isFounder: userProductPlan.isFounder,
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
): { plan: ResolvedProductPlan; value: T; isFounder: boolean } {
  const parsed = schema.safeParse(row.value);
  if (!parsed.success) {
    throw new ProductEntitlementUnavailableError(entitlementKey, "entitlement_malformed");
  }
  return {
    plan: { id: row.planId, displayName: row.displayName },
    value: parsed.data,
    isFounder: row.isFounder ?? false,
  };
}

export async function resolveEntitlementForUser<T>(
  db: Database,
  userId: string,
  entitlementKey: string,
  schema: z.ZodType<T>,
): Promise<{ plan: ResolvedProductPlan; value: T; isFounder: boolean }> {
  return parseStoredEntitlement(
    await resolveStoredEntitlementForUser(db, userId, entitlementKey),
    entitlementKey,
    schema,
  );
}

export async function resolveBotsMaxForUser(
  db: Database,
  userId: string,
): Promise<{ plan: ResolvedProductPlan; value: number; isFounder: boolean }> {
  return resolveEntitlementForUser(
    db,
    userId,
    BOTS_MAX_ENTITLEMENT_KEY,
    NonNegativeIntegerEntitlementSchema,
  );
}

export async function resolveMachinesMaxForUser(db: Database, userId: string) {
  return resolveEntitlementForUser(db, userId, MACHINES_MAX_ENTITLEMENT_KEY, NonNegativeIntegerEntitlementSchema);
}

export async function getMachineCapacitySummary(db: Database, ownerUserId: string): Promise<MachineCapacitySummary> {
  const [{ plan, value: limit, isFounder }, counts] = await Promise.all([
    resolveMachinesMaxForUser(db, ownerUserId),
    db.select({
      ownedCount: count(),
      onlineCount: sql<number>`COALESCE(SUM(CASE WHEN ${communityMachine.status} = 'online' THEN 1 ELSE 0 END), 0)`,
    }).from(communityMachine).where(eq(communityMachine.userId, ownerUserId)),
  ]);
  return { plan, isFounder, limit, ownedCount: counts[0]?.ownedCount ?? 0, onlineCount: counts[0]?.onlineCount ?? 0 };
}

export class MachineLimitReachedError extends Error {
  constructor(public readonly capacity: MachineCapacitySummary) {
    super("MACHINE_LIMIT_REACHED");
    this.name = "MachineLimitReachedError";
  }
}

export async function assertMachineCapacity(db: Database, userId: string, kind: "owned" | "online") {
  const capacity = await getMachineCapacitySummary(db, userId);
  if ((kind === "owned" ? capacity.ownedCount : capacity.onlineCount) >= capacity.limit) {
    throw new MachineLimitReachedError(capacity);
  }
  return capacity;
}

export async function getBotCapacitySummary(
  db: Database,
  ownerUserId: string,
): Promise<BotCapacitySummary> {
  const [{ plan, value: limit, isFounder }, counts] = await Promise.all([
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
    isFounder,
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
  guard?: SQL<unknown>,
) {
  return reconcileActiveBotsBuilder(db, and(eq(user.ownerUserId, ownerUserId), guard)!, botsMax);
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

export type DisconnectedMachine = { machineId: string; userId: string; doName: string | null };

export function machinesMaxForPlanSql(planId: string): SQL<number> {
  return sql<number>`COALESCE((
    SELECT CAST(e.value_json AS INTEGER) FROM product_plan_entitlement e
    INNER JOIN product_plan p ON p.id = e.plan_id AND p.is_active = 1
    WHERE e.plan_id = ${planId} AND e.entitlement_key = ${MACHINES_MAX_ENTITLEMENT_KEY}
      AND json_type(e.value_json) = 'integer' AND CAST(e.value_json AS INTEGER) >= 0 LIMIT 1
  ), 0)`;
}

function reconcileOnlineMachinesBuilders(db: Database, ownerCondition: SQL<unknown>, limit: number | SQL<number>) {
  const ranked = db.$with("ranked_online_machines").as(
    db.select({
      machineId: communityMachine.id,
      onlineRank: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${communityMachine.userId} ORDER BY ${communityMachine.createdAt} ASC, ${communityMachine.id} ASC
      )`.as("online_rank"),
    }).from(communityMachine).where(and(eq(communityMachine.status, "online"), ownerCondition)),
  );
  const overflow = db.with(ranked).select({ machineId: ranked.machineId }).from(ranked).where(gt(ranked.onlineRank, limit));
  const affected = db.select({
    machineId: communityMachine.id, userId: communityMachine.userId, doName: communityMachineCredential.doName,
  }).from(communityMachine).leftJoin(communityMachineCredential, and(
    eq(communityMachineCredential.machineId, communityMachine.id), isNull(communityMachineCredential.revokedAt),
  )).where(inArray(communityMachine.id, overflow));
  const now = new Date().toISOString();
  const runners = db.update(communityAgentRunnerKey).set({ revokedAt: now })
    .where(and(inArray(communityAgentRunnerKey.machineId, overflow), isNull(communityAgentRunnerKey.revokedAt)));
  const credentials = db.update(communityMachineCredential).set({ revokedAt: now })
    .where(and(inArray(communityMachineCredential.machineId, overflow), isNull(communityMachineCredential.revokedAt)));
  const offline = db.update(communityMachine).set({ status: "offline", lastSeenAt: now, updatedAt: now })
    .where(inArray(communityMachine.id, overflow));
  return [affected, runners, credentials, offline] as const;
}

export function reconcileOwnerOnlineMachinesBuilders(db: Database, userId: string, limit: number | SQL<number>, guard?: SQL<unknown>) {
  return reconcileOnlineMachinesBuilders(db, and(eq(communityMachine.userId, userId), guard)!, limit);
}

export function machinesMaxForUserSql(userId: string): SQL<number> {
  return sql<number>`COALESCE((
    SELECT CAST(e.value_json AS INTEGER)
    FROM product_plan_entitlement e
    INNER JOIN product_plan p ON p.id = e.plan_id AND p.is_active = 1
    LEFT JOIN user_product_plan up ON up.user_id = ${userId}
    WHERE e.entitlement_key = ${MACHINES_MAX_ENTITLEMENT_KEY}
      AND json_type(e.value_json) = 'integer' AND CAST(e.value_json AS INTEGER) >= 0
      AND p.id = COALESCE(up.plan_id, (SELECT id FROM product_plan WHERE is_default = 1 AND is_active = 1 LIMIT 1))
    LIMIT 1
  ), 0)`;
}

export function botsMaxForPlanSql(planId: string): SQL<number> {
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

export function nonFounderCondition(db: Database, userId: string): SQL<unknown> {
  return notExists(db.select({ one: sql<number>`1` }).from(userProductPlan).where(
    and(eq(userProductPlan.userId, userId), eq(userProductPlan.isFounder, true)),
  ));
}

export function assignUserPlanBuilder(
  db: Database,
  userId: string,
  planId: string,
  guard?: SQL<unknown>,
) {
  const now = new Date().toISOString();
  return db.insert(userProductPlan).select(db.select({
    userId: user.id,
    planId: sql<string>`${planId}`.as("plan_id"),
    isFounder: sql<boolean>`0`.as("is_founder"),
    assignedAt: sql<string>`${now}`.as("assigned_at"),
    updatedAt: sql<string>`${now}`.as("updated_at"),
  }).from(user).where(and(
    eq(user.id, userId), eq(user.isBot, false), isNull(user.deletedAt),
    nonFounderCondition(db, userId), guard,
  ))).onConflictDoUpdate({
    target: userProductPlan.userId,
    set: { planId, updatedAt: now },
    setWhere: and(eq(userProductPlan.isFounder, false), guard),
  }).returning({ userId: userProductPlan.userId });
}

export async function assignUserPlan(
  db: Database,
  userId: string,
  planId: string,
): Promise<{ plan: ResolvedProductPlan; limit: number; deactivatedBotIds: string[]; disconnectedMachines: DisconnectedMachine[] }> {
  const resolved = parseStoredEntitlement(
    await resolveStoredEntitlementForPlan(db, planId, BOTS_MAX_ENTITLEMENT_KEY),
    BOTS_MAX_ENTITLEMENT_KEY,
    NonNegativeIntegerEntitlementSchema,
  );
  parseStoredEntitlement(await resolveStoredEntitlementForPlan(db, planId, MACHINES_MAX_ENTITLEMENT_KEY), MACHINES_MAX_ENTITLEMENT_KEY, NonNegativeIntegerEntitlementSchema);
  const guard = and(nonFounderCondition(db, userId), exists(
    db.select({ id: user.id }).from(user).where(and(
      eq(user.id, userId), eq(user.isBot, false), isNull(user.deletedAt),
    )),
  ))!;
  const assign = assignUserPlanBuilder(db, userId, planId, guard);
  const reconcile = reconcileOwnerActiveBotsBuilder(
    db, userId, botsMaxForPlanSql(planId), guard,
  );
  const machines = reconcileOwnerOnlineMachinesBuilders(db, userId, machinesMaxForPlanSql(planId), guard);
  const results = await db.batch([assign, reconcile, ...machines]);

  if (results[0].length === 0) throw new Error("PLAN_ASSIGNMENT_PROTECTED");
  return {
    plan: resolved.plan,
    limit: resolved.value,
    deactivatedBotIds: results[1].map((row) => row.botId),
    disconnectedMachines: results[2],
  };
}

export async function setPlanEntitlement(
  db: Database,
  planId: string,
  entitlementKey: string,
  value: EntitlementValue,
): Promise<{ deactivatedBotIds: string[]; disconnectedMachines?: DisconnectedMachine[] }> {
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
  if (entitlementKey === MACHINES_MAX_ENTITLEMENT_KEY) {
    const parsed = NonNegativeIntegerEntitlementSchema.safeParse(parsedValue);
    if (!parsed.success) throw new ProductEntitlementUnavailableError(entitlementKey, "entitlement_malformed");
    const explicit = inArray(communityMachine.userId, db.select({ id: userProductPlan.userId }).from(userProductPlan).where(eq(userProductPlan.planId, planId)));
    const defaultPlan = exists(db.select({ id: productPlan.id }).from(productPlan).where(and(eq(productPlan.id, planId), eq(productPlan.isDefault, true))));
    const unassigned = notExists(db.select({ id: userProductPlan.userId }).from(userProductPlan).where(eq(userProductPlan.userId, communityMachine.userId)));
    const machines = reconcileOnlineMachinesBuilders(db, or(explicit, and(defaultPlan, unassigned))!, parsed.data);
    const results = await db.batch([write, ...machines]);
    return { deactivatedBotIds: [], disconnectedMachines: results[1] };
  }
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
