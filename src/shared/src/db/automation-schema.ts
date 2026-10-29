import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { user } from "./schema"
import type { AutomationPermission } from "../automation"

export const automationAccessCode = sqliteTable("automation_access_code", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  secretHash: text("secret_hash").notNull().unique(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_automation_code_owner").on(table.ownerId)])

export const automationAccessPermission = sqliteTable("automation_access_permission", {
  codeId: text("code_id").notNull().references(() => automationAccessCode.id, { onDelete: "cascade" }),
  permission: text("permission").$type<AutomationPermission>().notNull(),
  limit: integer("request_limit").notNull(),
  period: text("period", { enum: ["hour", "day"] }).notNull(),
}, (table) => [primaryKey({ columns: [table.codeId, table.permission] })])
