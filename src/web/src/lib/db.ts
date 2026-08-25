import { createDb, type Database } from "@alook/shared"

export { withD1Retry } from "@alook/shared"

export function getDb(d1: D1Database): Database {
  const session = d1.withSession("first-unconstrained")
  return createDb(session as unknown as Parameters<typeof createDb>[0])
}

export function getPrimaryDb(d1: D1Database): Database {
  const session = d1.withSession("first-primary")
  return createDb(session as unknown as Parameters<typeof createDb>[0])
}
