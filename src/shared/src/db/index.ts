import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import * as communitySchema from "./community-schema";

const allSchema = { ...schema, ...communitySchema };

export function createDb(d1: AnyD1Database) {
  return drizzle(d1, { schema: allSchema });
}

export type Database = ReturnType<typeof createDb>;
