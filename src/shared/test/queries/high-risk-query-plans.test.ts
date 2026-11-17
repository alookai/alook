import { describe, expect, it } from "vitest"
import { createMigratedDb } from "../helpers/migrated-db"
import { assertNoBusinessTableScans, businessTableScans, type BoundQuery } from "../helpers/query-plan"
import * as bots from "../../src/db/queries/community/bot"
import * as dm from "../../src/db/queries/community/dm"
import * as machine from "../../src/db/queries/community/machine"
import { removeMemberAndOwnerBots } from "../../src/db/queries/community/member"
import * as rail from "../../src/db/queries/community/server-rail"
import * as users from "../../src/db/queries/user"
import * as plans from "../../src/db/queries/product-plan"
import { registerAttempt } from "../../src/db/queries/native-oauth"
import { listPendingAccountDeletions } from "../../src/db/queries/account-deletion"
import { BOT_ACTIVITY_PRESETS } from "../../src/community/bot-activity-presets"

describe("database query plans on current migrations", () => {
  it("rejects full table and full index scans, including aliases and nested subqueries", () => {
    const { sqlite } = createMigratedDb()
    try {
      for (const sql of [
        "SELECT id FROM community_message",
        "SELECT id FROM community_message AS candidate WHERE NOT EXISTS (SELECT 1 FROM community_message AS newer WHERE newer.channel_id = candidate.channel_id AND newer.seq > candidate.seq)",
        "SELECT id FROM user INDEXED BY idx_user_name_discriminator WHERE deletedAt IS NULL AND name LIKE '%middle%'",
      ]) expect(() => assertNoBusinessTableScans(sqlite, { sql, params: [] })).toThrow("Unbounded business-table scan")
      expect(() => assertNoBusinessTableScans(sqlite, { sql: "SELECT id FROM community_message WHERE id=?", params: ["message"] })).not.toThrow()
      expect(() => assertNoBusinessTableScans(sqlite, { sql: "SELECT value FROM json_each(?)", params: ['["bounded-input"]'] })).not.toThrow()
    } finally { sqlite.close() }
  })

  it("indexes current community and billing foreign-key lookups so one parent mutation cannot scan a whole child table", () => {
    const { sqlite } = createMigratedDb()
    try {
      const failures: string[] = []
      const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      for (const { name } of tables) {
        if (!name.startsWith("community_") && name !== "billing_price" && name !== "product_analytics_event") continue
        const references = sqlite.pragma(`foreign_key_list(${JSON.stringify(name)})`) as Array<{ id: number; seq: number; from: string }>
        for (const id of new Set(references.map(row => row.id))) {
          const columns = references.filter(row => row.id === id).sort((a, b) => a.seq - b.seq).map(row => row.from)
          const query = { sql: `SELECT 1 FROM ${JSON.stringify(name)} WHERE ${columns.map(column => `${JSON.stringify(column)} = ?`).join(" AND ")}`, params: columns.map(() => "parent") }
          failures.push(...businessTableScans(sqlite, query))
        }
      }
      expect(failures).toEqual([])
    } finally { sqlite.close() }
  })

  it("keeps real activation, DM, reconnect, folder, identity, deletion and plan queries indexed", async () => {
    const executed: BoundQuery[] = []
    const { sqlite, db } = createMigratedDb({ logQuery(sql, params) { executed.push({ sql, params }) } })
    try {
      sqlite.exec(`
        INSERT INTO user(id,name,email,discriminator) VALUES('owner','Owner','owner@test.example','9999');
        INSERT INTO community_machine(id,user_id,display_name,hostname,platform,arch,available_runtimes,status,created_at,updated_at)
          VALUES('machine','owner','QA','host','darwin','arm64','[]','online','2026-01-01','2026-01-01');
      `)
      const { botId } = await bots.createBot(db, { ownerId: "owner", name: "bot", machineId: "machine", runtime: "codex-cli" })
      sqlite.prepare("UPDATE community_bot_binding SET is_active=0 WHERE user_id=?").run(botId)
      await bots.setBotActive(db, botId, "owner", true)
      await dm.createOrGetDM(db, { userId1: "owner", userId2: botId })
      await dm.createOrGetDM(db, { userId1: "owner", userId2: botId })
      sqlite.prepare("UPDATE community_user_profile SET status_emoji=?,status_text=? WHERE user_id=?").run(BOT_ACTIVITY_PRESETS.starting.emoji, BOT_ACTIVITY_PRESETS.starting.text, botId)
      await machine.reconcileBotActivityFromRunningAgents(db, "machine", [])
      await users.searchUsersByName(db, "Own")
      await users.getUserByProviderAccount(db, "github", "account")
      await listPendingAccountDeletions(db)
      await registerAttempt(db, { id: "indexed_attempt_123456789", instanceKeyHash: "a".repeat(64), stateHash: "b".repeat(64), pkceChallenge: "c".repeat(43), provider: "google", platform: "macos", redirectPath: "/c" })
      await plans.setPlanEntitlement(db, "free", "bots.max", 5)
      await plans.setPlanEntitlement(db, "free", "machines.max", 5)
      await removeMemberAndOwnerBots(db, "membership", "server", "owner", [botId])
      const state = { serverIds: [], folderIds: [], folders: {} }
      const statements = rail.buildServerRailWriteStatements(db, "owner", { before: state, after: state, createdFolders: [], deletedFolderIds: ["folder"], affectedFolderIds: ["folder"], movedServerIds: ["server"], reorderTopLevel: false, createdFolderIds: {} })
      for (const statement of statements) executed.push(statement.toSQL())
      executed.push({ sql: "SELECT id FROM community_attachment WHERE r2_key = ? OR thumbnail_r2_key = ? LIMIT 1", params: ["object", "object"] })
      expect(executed).not.toHaveLength(0)
      const scans = executed.flatMap(query => businessTableScans(sqlite, query))
      expect(scans).toEqual([])
    } finally { sqlite.close() }
  })
})
