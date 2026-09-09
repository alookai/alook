import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { user } from "./schema";

export const productPlan = sqliteTable(
  "product_plan",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex("uq_product_plan_active_default")
      .on(t.isDefault)
      .where(sql`${t.isDefault} = 1 AND ${t.isActive} = 1`),
  ],
);

export const productPlanEntitlement = sqliteTable(
  "product_plan_entitlement",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => productPlan.id, { onDelete: "cascade" }),
    entitlementKey: text("entitlement_key").notNull(),
    valueJson: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.entitlementKey] }),
    index("idx_product_plan_entitlement_key").on(t.entitlementKey, t.planId),
  ],
);

export const userProductPlan = sqliteTable(
  "user_product_plan",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => productPlan.id, { onDelete: "restrict" }),
    assignedAt: text("assigned_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index("idx_user_product_plan_plan").on(t.planId)],
);
