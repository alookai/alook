import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Operation, PageLimits, Phase, Release, Stage } from "./contracts"

export const pages = sqliteTable("pages", {
  id: text("id").primaryKey(),
  prefix: text("prefix").notNull().unique(),
  namespace: text("namespace").notNull(),
  account: text("account").notNull(),
  phase: text("phase").$type<Phase>().notNull(),
  active: text("active", { mode: "json" }).$type<Release>(),
  releases: text("releases", { mode: "json" }).$type<Release[]>().notNull(),
  operation: text("operation", { mode: "json" }).$type<Operation>().notNull(),
  currentOp: text("current_op"),
  stage: text("stage").$type<Stage>(),
  error: text("error"),
  revision: integer("revision").notNull(),
  version: integer("version").notNull(),
  limits: text("limits", { mode: "json" }).$type<PageLimits>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export type PageRow = typeof pages.$inferSelect
