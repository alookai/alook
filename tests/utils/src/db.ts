import Database from "better-sqlite3"
import { readdirSync } from "fs"
import { join } from "path"
import { resolve } from "path"

const D1_STATE_DIR = resolve(
  import.meta.dirname,
  "../../../src/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject",
)

let _db: Database.Database | null = null

function getDbPath(): string {
  const files = readdirSync(D1_STATE_DIR).filter(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
  )
  if (files.length === 0) {
    throw new Error(
      `No D1 SQLite file found in ${D1_STATE_DIR}. Run migrations first: pnpm db:migrate`,
    )
  }
  return join(D1_STATE_DIR, files[0])
}

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(getDbPath())
    _db.pragma("journal_mode = WAL")
    _db.pragma("busy_timeout = 5000")
  }
  return _db
}

export function sql(query: string): void {
  const db = getDb()
  db.exec(query)
}

export function sqlRun(query: string, ...params: unknown[]): void {
  const db = getDb()
  db.prepare(query).run(...params)
}

export function sqlQuery<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[] {
  const db = getDb()
  const stmt = db.prepare(query)
  return (params.length ? stmt.all(...params) : stmt.all()) as T[]
}

export function sqlBatch(queries: string[]): void {
  const db = getDb()
  const transaction = db.transaction(() => {
    for (const query of queries) {
      const trimmed = query.trim()
      if (trimmed) {
        db.exec(trimmed)
      }
    }
  })
  transaction()
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
