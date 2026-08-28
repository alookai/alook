import { sql } from "drizzle-orm";
import type { Database } from "../index";

export function jsonTextSet(db: Database, values: readonly string[]) {
  return db
    .select({ value: sql<string>`CAST(value AS TEXT)`.as("value") })
    .from(sql`json_each(${JSON.stringify(values)})`);
}
