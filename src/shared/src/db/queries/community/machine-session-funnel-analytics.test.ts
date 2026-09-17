import Sqlite from "better-sqlite3"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as communityFunnelAnalyticsSchema from "../../community-funnel-analytics-schema"
import * as communityMachineSchema from "../../community-machine-schema"
import * as productPlanSchema from "../../product-plan-schema"
import * as userSchema from "../../schema"
import type { Database } from "../../index"
import { claimPendingEvents } from "./funnel-analytics"
import { transitionMachineSessionEpoch } from "./machine-session-epoch"

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../../web/migrations/0103_community_funnel_analytics_event.sql",
)

type BatchStatement = { all(): unknown; run(): unknown }

function createTestDb(sqlite: Sqlite.Database): Database {
  const db = drizzle(sqlite, {
    schema: {
      ...userSchema,
      ...communityMachineSchema,
      ...productPlanSchema,
      ...communityFunnelAnalyticsSchema,
    },
  })
  Object.assign(db, {
    batch: async (statements: BatchStatement[]) => sqlite.transaction(() =>
      statements.map((statement, index) => index === 0 ? statement.all() : statement.run()),
    )(),
  })
  return db as unknown as Database
}

describe("machine ready funnel boundary", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY NOT NULL,
        isBot INTEGER NOT NULL,
        deletedAt TEXT
      );
      CREATE TABLE community_machine (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        arch TEXT NOT NULL DEFAULT '',
        os_release TEXT NOT NULL DEFAULT '',
        daemon_version TEXT NOT NULL DEFAULT '',
        time_zone TEXT,
        metadata TEXT,
        available_runtimes TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE community_machine_credential (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE,
        do_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE product_plan (
        id TEXT PRIMARY KEY NOT NULL,
        is_default INTEGER NOT NULL,
        is_active INTEGER NOT NULL
      );
      CREATE TABLE product_plan_entitlement (
        plan_id TEXT NOT NULL,
        entitlement_key TEXT NOT NULL,
        value_json TEXT NOT NULL
      );
      CREATE TABLE user_product_plan (
        user_id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL
      );
    `)
    sqlite.exec(readFileSync(migrationPath, "utf8"))
    sqlite.prepare("INSERT INTO user (id, isBot) VALUES ('owner', 0)").run()
    sqlite.prepare("INSERT INTO product_plan (id, is_default, is_active) VALUES ('free', 1, 1)").run()
    sqlite.prepare("INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json) VALUES ('free', 'machines.max', '3')").run()
    sqlite.prepare(`
      INSERT INTO community_machine
        (id, user_id, display_name, hostname, platform, arch, os_release, daemon_version, available_runtimes, status, created_at, updated_at)
      VALUES ('machine', 'owner', '', '', '', '', '', '', '[]', 'offline', '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z')
    `).run()
    sqlite.prepare(`
      INSERT INTO community_machine_credential
        (id, user_id, machine_id, credential_hash, do_name, created_at)
      VALUES ('credential', 'owner', 'machine', 'hash', 'do-name', '2026-09-14T00:00:00.000Z')
    `).run()
    db = createTestDb(sqlite)
  })

  afterEach(() => sqlite.close())

  it("records only the first authenticated ready transition for one credential epoch", async () => {
    const epoch = { userId: "owner", machineId: "machine", credentialHash: "hash" }
    const metadata = { hostname: "host", availableRuntimes: [] }

    await expect(transitionMachineSessionEpoch(db, {
      type: "ready",
      epoch,
      metadata,
    })).resolves.toMatchObject({ type: "transitioned", machine: { status: "online" } })
    await expect(transitionMachineSessionEpoch(db, {
      type: "ready",
      epoch,
      metadata,
    })).resolves.toMatchObject({ type: "transitioned" })
    await expect(transitionMachineSessionEpoch(db, {
      type: "renew",
      epoch,
    })).resolves.toMatchObject({ type: "transitioned" })

    await expect(claimPendingEvents(db, "owner")).resolves.toEqual([
      { event: "runtime_connected", surface: "community", connection_type: "local_daemon" },
    ])
  })

  it("does not record a stale credential epoch", async () => {
    await expect(transitionMachineSessionEpoch(db, {
      type: "ready",
      epoch: { userId: "owner", machineId: "machine", credentialHash: "stale" },
      metadata: { hostname: "host" },
    })).resolves.toEqual({ type: "stale_epoch" })
    await expect(claimPendingEvents(db, "owner")).resolves.toEqual([])
  })
})
