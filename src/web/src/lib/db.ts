import { createDb, type Database } from "@alook/shared"

export function getDb(d1: D1Database): Database {
  const session = d1.withSession("first-primary")
  // D1DatabaseSession has prepare() + batch() which is all Drizzle uses at runtime.
  // Native Drizzle support tracked at https://github.com/drizzle-team/drizzle-orm/issues/4522
  return createDb(session as unknown as Parameters<typeof createDb>[0])
}
