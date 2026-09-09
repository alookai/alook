import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Sqlite from "better-sqlite3"
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3"
import { z } from "zod"
import * as productPlanQuery from "../../src/db/queries/product-plan"

type ExecutableStatement = {
  toSQL(): { sql: string }
  all(): unknown[]
  run(): unknown
}

function createDatabase() {
  const sqlite = new Sqlite(":memory:")
  sqlite.pragma("foreign_keys = ON")
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      discriminator TEXT NOT NULL DEFAULT '0000',
      email TEXT NOT NULL DEFAULT '',
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      avatarVersion INTEGER NOT NULL DEFAULT 0,
      avatarObjectKey TEXT,
      isBot INTEGER NOT NULL DEFAULT 0,
      ownerUserId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      lastRefreshContextAt TEXT
    );
    CREATE TABLE community_bot_binding (
      user_id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'codex',
      instruction TEXT NOT NULL DEFAULT '',
      model_name TEXT,
      reasoning_effort TEXT,
      runtime_config_revision INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE product_plan (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE product_plan_entitlement (
      plan_id TEXT NOT NULL REFERENCES product_plan(id) ON DELETE CASCADE,
      entitlement_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (plan_id, entitlement_key)
    );
    CREATE TABLE user_product_plan (
      user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES product_plan(id) ON DELETE RESTRICT,
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE community_category (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE community_channel (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      category_id TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      parent_channel_id TEXT,
      creator_id TEXT
    );
    CREATE TABLE community_server_member (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL
    );
    CREATE TABLE community_channel_member (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'access'
    );
    CREATE TABLE community_friendship (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      addressee_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE community_message (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
    CREATE TABLE community_read_state (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      last_read_at TEXT NOT NULL,
      last_read_message_id TEXT,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, channel_id)
    );
    CREATE TABLE community_read_state_revision (
      user_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER enforce_active_bot_entitlement_before_update
    BEFORE UPDATE OF is_active ON community_bot_binding
    WHEN NEW.is_active = 1 AND OLD.is_active = 0 AND (
      SELECT COUNT(*)
      FROM community_bot_binding active_binding
      INNER JOIN user active_bot ON active_bot.id = active_binding.user_id
      WHERE active_bot.ownerUserId = (
        SELECT ownerUserId FROM user WHERE id = NEW.user_id
      )
        AND active_bot.isBot = 1
        AND active_bot.deletedAt IS NULL
        AND active_binding.is_active = 1
    ) >= COALESCE((
      SELECT CAST(e.value_json AS INTEGER)
      FROM product_plan_entitlement e
      INNER JOIN product_plan p ON p.id = e.plan_id AND p.is_active = 1
      LEFT JOIN user_product_plan up ON up.user_id = (
        SELECT ownerUserId FROM user WHERE id = NEW.user_id
      )
      WHERE e.entitlement_key = 'bots.max'
        AND json_type(e.value_json) = 'integer'
        AND CAST(e.value_json AS INTEGER) >= 0
        AND p.id = COALESCE(
          up.plan_id,
          (SELECT id FROM product_plan WHERE is_default = 1 AND is_active = 1 LIMIT 1)
        )
      LIMIT 1
    ), 0)
    BEGIN
      SELECT RAISE(ABORT, 'BOT_ENTITLEMENT_LIMIT_REACHED');
    END;
  `)
  const db = drizzleSqlite(sqlite) as ReturnType<typeof drizzleSqlite> & {
    batch(statements: ExecutableStatement[]): Promise<unknown[]>
  }
  db.batch = async (statements: ExecutableStatement[]) => sqlite.transaction(() =>
    statements.map((statement) => (
      /\breturning\b/i.test(statement.toSQL().sql) ? statement.all() : statement.run()
    )),
  )()
  return { sqlite, db }
}

function seedPlan(sqlite: Sqlite.Database, input: {
  id: string
  displayName?: string
  isDefault?: boolean
  isActive?: boolean
  botsMax?: string
}) {
  sqlite.prepare(`
    INSERT INTO product_plan (id, display_name, is_default, is_active)
    VALUES (?, ?, ?, ?)
  `).run(
    input.id,
    input.displayName ?? input.id,
    input.isDefault ? 1 : 0,
    input.isActive === false ? 0 : 1,
  )
  if (input.botsMax !== undefined) {
    sqlite.prepare(`
      INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json)
      VALUES (?, 'bots.max', ?)
    `).run(input.id, input.botsMax)
  }
}

function seedHuman(sqlite: Sqlite.Database, id: string, planId?: string) {
  sqlite.prepare(`
    INSERT INTO user (id, createdAt, updatedAt) VALUES (?, '2026-01-01', '2026-01-01')
  `).run(id)
  if (planId) {
    sqlite.prepare(`INSERT INTO user_product_plan (user_id, plan_id) VALUES (?, ?)`).run(id, planId)
  }
}

function seedBot(
  sqlite: Sqlite.Database,
  ownerId: string,
  id: string,
  createdAt: string,
  active = true,
) {
  sqlite.prepare(`
    INSERT INTO user (id, name, isBot, ownerUserId, createdAt, updatedAt)
    VALUES (?, ?, 1, ?, ?, ?)
  `).run(id, id, ownerId, createdAt, createdAt)
  sqlite.prepare(`
    INSERT INTO community_bot_binding (user_id, machine_id, is_active)
    VALUES (?, 'machine_1', ?)
  `).run(id, active ? 1 : 0)
}

describe("generic product plan entitlement queries", () => {
  let sqlite: Sqlite.Database
  let db: ReturnType<typeof createDatabase>["db"]

  beforeEach(() => ({ sqlite, db } = createDatabase()))
  afterEach(() => sqlite.close())

  it("uses the active default without an assignment and lets an explicit assignment override it", async () => {
    seedPlan(sqlite, { id: "default-plan", displayName: "Default", isDefault: true, botsMax: "3" })
    seedPlan(sqlite, { id: "larger-plan", displayName: "Larger", botsMax: "11" })
    seedHuman(sqlite, "unassigned")
    seedHuman(sqlite, "assigned", "larger-plan")

    await expect(productPlanQuery.resolveBotsMaxForUser(db as never, "unassigned")).resolves.toEqual({
      plan: { id: "default-plan", displayName: "Default" },
      value: 3,
    })
    await expect(productPlanQuery.resolveBotsMaxForUser(db as never, "assigned")).resolves.toEqual({
      plan: { id: "larger-plan", displayName: "Larger" },
      value: 11,
    })
  })

  it("resolves a newly inserted plan and structured entitlement without application branching", async () => {
    seedPlan(sqlite, { id: "new-tier", displayName: "New Tier", botsMax: "17" })
    seedHuman(sqlite, "owner", "new-tier")
    sqlite.prepare(`
      INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json)
      VALUES ('new-tier', 'feature.workflow', '{"enabled":true,"modes":["fast"]}')
    `).run()
    sqlite.prepare(`
      INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json)
      VALUES ('new-tier', 'feature.optional', 'null')
    `).run()

    await expect(productPlanQuery.resolveBotsMaxForUser(db as never, "owner")).resolves.toMatchObject({
      plan: { id: "new-tier" },
      value: 17,
    })
    await expect(productPlanQuery.resolveEntitlementForUser(
      db as never,
      "owner",
      "feature.workflow",
      z.object({ enabled: z.boolean(), modes: z.array(z.string()) }),
    )).resolves.toMatchObject({ value: { enabled: true, modes: ["fast"] } })
    await expect(productPlanQuery.resolveEntitlementForUser(
      db as never,
      "owner",
      "feature.optional",
      z.null(),
    )).resolves.toMatchObject({ value: null })
  })

  it("fails closed for missing, malformed, and inactive catalog data", async () => {
    seedPlan(sqlite, { id: "missing", isDefault: true })
    seedHuman(sqlite, "owner", "missing")

    await expect(productPlanQuery.resolveBotsMaxForUser(db as never, "owner")).rejects.toMatchObject({
      reason: "entitlement_missing",
    })

    sqlite.prepare(`
      INSERT INTO product_plan_entitlement (plan_id, entitlement_key, value_json)
      VALUES ('missing', 'bots.max', '"3"')
    `).run()
    await expect(productPlanQuery.resolveBotsMaxForUser(db as never, "owner")).rejects.toMatchObject({
      reason: "entitlement_malformed",
    })

    sqlite.prepare(`UPDATE product_plan SET is_active = 0 WHERE id = 'missing'`).run()
    await expect(productPlanQuery.resolveBotsMaxForUser(db as never, "owner")).rejects.toMatchObject({
      reason: "plan_unavailable",
    })
  })

  it("counts all live owned bots for creation capacity while counting Active separately", async () => {
    seedPlan(sqlite, { id: "free", displayName: "Free", isDefault: true, botsMax: "3" })
    seedHuman(sqlite, "owner")
    seedBot(sqlite, "owner", "active", "2026-01-01", true)
    seedBot(sqlite, "owner", "inactive", "2026-01-02", false)
    seedBot(sqlite, "owner", "deleted", "2026-01-03", true)
    sqlite.prepare(`UPDATE user SET deletedAt = '2026-02-01' WHERE id = 'deleted'`).run()

    await expect(productPlanQuery.getBotCapacitySummary(db as never, "owner")).resolves.toEqual({
      plan: { id: "free", displayName: "Free" },
      limit: 3,
      ownedCount: 2,
      activeCount: 1,
    })
  })

  it("downgrades deterministically without deletion, while an upgrade never reactivates", async () => {
    seedPlan(sqlite, { id: "small", displayName: "Small", isDefault: true, botsMax: "2" })
    seedPlan(sqlite, { id: "large", displayName: "Large", botsMax: "5" })
    seedHuman(sqlite, "owner", "large")
    seedBot(sqlite, "owner", "bot_b", "2026-01-01", true)
    seedBot(sqlite, "owner", "bot_a", "2026-01-01", true)
    seedBot(sqlite, "owner", "bot_c", "2026-01-02", true)

    await expect(productPlanQuery.assignUserPlan(db as never, "owner", "small")).resolves.toMatchObject({
      plan: { id: "small", displayName: "Small" },
      limit: 2,
      deactivatedBotIds: ["bot_c"],
    })
    expect(sqlite.prepare(`
      SELECT u.id, b.is_active AS isActive
      FROM user u JOIN community_bot_binding b ON b.user_id = u.id
      WHERE u.ownerUserId = 'owner' ORDER BY u.id
    `).all()).toEqual([
      { id: "bot_a", isActive: 1 },
      { id: "bot_b", isActive: 1 },
      { id: "bot_c", isActive: 0 },
    ])

    await productPlanQuery.assignUserPlan(db as never, "owner", "large")
    expect(sqlite.prepare(`SELECT is_active FROM community_bot_binding WHERE user_id = 'bot_c'`).get())
      .toEqual({ is_active: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM user WHERE ownerUserId = 'owner'`).get())
      .toEqual({ n: 3 })
  })

  it("reactivates atomically after advancing every visible non-empty scope to its execution-time latest message", async () => {
    seedPlan(sqlite, { id: "free", displayName: "Free", isDefault: true, botsMax: "5" })
    seedHuman(sqlite, "owner")
    seedBot(sqlite, "owner", "bot", "2026-01-01", false)
    seedHuman(sqlite, "peer")
    sqlite.exec(`
      INSERT INTO community_category (id, server_id, private)
      VALUES ('private_category', 'server', 1);
      INSERT INTO community_channel (id, server_id, type)
      VALUES
        ('public', 'server', 'text'),
        ('thread_parent', 'server', 'text'),
        ('empty', 'server', 'text');
      INSERT INTO community_channel (id, server_id, category_id, type)
      VALUES ('private', 'server', 'private_category', 'text');
      INSERT INTO community_channel (id, server_id, type, parent_channel_id)
      VALUES ('thread', 'server', 'thread', 'thread_parent');
      INSERT INTO community_channel (id, type)
      VALUES ('dm', 'dm');
      INSERT INTO community_server_member (id, server_id, user_id)
      VALUES ('sm_bot', 'server', 'bot');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation)
      VALUES
        ('private_access', 'private', 'bot', 'access'),
        ('dm_bot', 'dm', 'bot', 'access'),
        ('dm_peer', 'dm', 'peer', 'access');
      INSERT INTO community_message (id, author_id, created_at, channel_id, seq)
      VALUES
        ('public_1', 'owner', '2026-02-01T00:00:01Z', 'public', 1),
        ('public_2', 'owner', '2026-02-01T00:00:02Z', 'public', 2),
        ('private_4', 'owner', '2026-02-01T00:00:04Z', 'private', 4),
        ('thread_3', 'owner', '2026-02-01T00:00:03Z', 'thread', 3),
        ('dm_7', 'peer', '2026-02-01T00:00:07Z', 'dm', 7);
      INSERT INTO community_read_state (
        id, user_id, channel_id, last_read_at, last_read_message_id, last_read_seq
      ) VALUES ('old_public_cursor', 'bot', 'public', '2026-02-01T00:00:01Z', 'public_1', 1);
    `)

    await expect(productPlanQuery.getBotCapacitySummary(db as never, "owner")).resolves.toMatchObject({
      limit: 5,
      activeCount: 0,
    })
    const result = await import("../../src/db/queries/community/bot").then(({ setBotActive }) =>
      setBotActive(db as never, "bot", "owner", true),
    )
    expect(result).toMatchObject({ state: "updated", bot: { id: "bot", isActive: true } })
    expect(sqlite.prepare(`
      SELECT channel_id AS channelId, last_read_message_id AS messageId, last_read_seq AS seq
      FROM community_read_state WHERE user_id = 'bot' ORDER BY channel_id
    `).all()).toEqual([
      { channelId: "dm", messageId: "dm_7", seq: 7 },
      { channelId: "private", messageId: "private_4", seq: 4 },
      { channelId: "public", messageId: "public_2", seq: 2 },
      { channelId: "thread", messageId: "thread_3", seq: 3 },
    ])
    expect(sqlite.prepare(`SELECT revision FROM community_read_state_revision WHERE user_id = 'bot'`).get())
      .toEqual({ revision: 1 })
    expect(sqlite.prepare(`SELECT is_active FROM community_bot_binding WHERE user_id = 'bot'`).get())
      .toEqual({ is_active: 1 })

    sqlite.prepare(`
      INSERT INTO community_message (id, author_id, created_at, channel_id, seq)
      VALUES ('public_3', 'owner', '2026-02-01T00:00:08Z', 'public', 3)
    `).run()
    expect(sqlite.prepare(`
      SELECT last_read_seq FROM community_read_state
      WHERE user_id = 'bot' AND channel_id = 'public'
    `).get()).toEqual({ last_read_seq: 2 })
  })

  it("reconciles both explicit and default-plan owners when bots.max itself is lowered", async () => {
    seedPlan(sqlite, { id: "target", displayName: "Target", isDefault: true, botsMax: "5" })
    seedPlan(sqlite, { id: "other", displayName: "Other", botsMax: "5" })
    seedHuman(sqlite, "default_owner")
    seedHuman(sqlite, "explicit_owner", "target")
    seedHuman(sqlite, "other_owner", "other")
    for (const owner of ["default_owner", "explicit_owner", "other_owner"]) {
      seedBot(sqlite, owner, `${owner}_a`, "2026-01-01", true)
      seedBot(sqlite, owner, `${owner}_b`, "2026-01-02", true)
      seedBot(sqlite, owner, `${owner}_c`, "2026-01-03", true)
    }

    const result = await productPlanQuery.setPlanEntitlement(db as never, "target", "bots.max", 2)

    expect(new Set(result.deactivatedBotIds)).toEqual(new Set([
      "default_owner_c",
      "explicit_owner_c",
    ]))
    const counts = sqlite.prepare(`
      SELECT u.ownerUserId AS ownerId, SUM(b.is_active) AS activeCount
      FROM user u JOIN community_bot_binding b ON b.user_id = u.id
      GROUP BY u.ownerUserId ORDER BY u.ownerUserId
    `).all()
    expect(counts).toEqual([
      { ownerId: "default_owner", activeCount: 2 },
      { ownerId: "explicit_owner", activeCount: 2 },
      { ownerId: "other_owner", activeCount: 3 },
    ])
    expect(sqlite.prepare(`
      SELECT value_json FROM product_plan_entitlement
      WHERE plan_id = 'target' AND entitlement_key = 'bots.max'
    `).get()).toEqual({ value_json: "2" })

    await productPlanQuery.setPlanEntitlement(db as never, "target", "bots.max", 5)
    expect(sqlite.prepare(`
      SELECT is_active FROM community_bot_binding
      WHERE user_id IN ('default_owner_c', 'explicit_owner_c') ORDER BY user_id
    `).all()).toEqual([{ is_active: 0 }, { is_active: 0 }])
  })

  it("keeps activation owner-scoped and deactivation idempotent", async () => {
    const { setBotActive } = await import("../../src/db/queries/community/bot")
    seedPlan(sqlite, { id: "free", isDefault: true, botsMax: "3" })
    seedHuman(sqlite, "owner")
    seedHuman(sqlite, "other_owner")
    seedBot(sqlite, "owner", "bot", "2026-01-01", true)

    await expect(setBotActive(db as never, "bot", "other_owner", false)).resolves.toEqual({
      state: "not_found",
    })
    expect(sqlite.prepare(`SELECT is_active FROM community_bot_binding WHERE user_id = 'bot'`).get())
      .toEqual({ is_active: 1 })

    await expect(setBotActive(db as never, "bot", "owner", false)).resolves.toMatchObject({
      state: "updated",
      bot: { id: "bot", isActive: false },
    })
    await expect(setBotActive(db as never, "bot", "owner", false)).resolves.toMatchObject({
      state: "unchanged",
      bot: { id: "bot", isActive: false },
    })
  })

  it("rolls cursor catch-up back when a concurrent activation consumes the final slot", async () => {
    const { setBotActive } = await import("../../src/db/queries/community/bot")
    seedPlan(sqlite, { id: "free", displayName: "Free", isDefault: true, botsMax: "1" })
    seedHuman(sqlite, "owner")
    seedBot(sqlite, "owner", "target", "2026-01-01", false)
    sqlite.exec(`
      INSERT INTO community_channel (id, server_id, type) VALUES ('public', 'server', 'text');
      INSERT INTO community_server_member (id, server_id, user_id) VALUES ('sm', 'server', 'target');
      INSERT INTO community_message (id, author_id, created_at, channel_id, seq)
      VALUES ('message_1', 'owner', '2026-02-01T00:00:01Z', 'public', 1);
    `)
    const executeBatch = db.batch.bind(db)
    let injectedRace = false
    db.batch = async (statements: ExecutableStatement[]) => {
      if (!injectedRace) {
        injectedRace = true
        seedBot(sqlite, "owner", "racer", "2026-01-02", true)
      }
      return executeBatch(statements)
    }

    await expect(setBotActive(db as never, "target", "owner", true)).resolves.toEqual({
      state: "capacity",
      capacity: {
        plan: { id: "free", displayName: "Free" },
        limit: 1,
        ownedCount: 2,
        activeCount: 1,
      },
    })
    expect(sqlite.prepare(`SELECT is_active FROM community_bot_binding WHERE user_id = 'target'`).get())
      .toEqual({ is_active: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM community_read_state WHERE user_id = 'target'`).get())
      .toEqual({ n: 0 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM community_read_state_revision WHERE user_id = 'target'`).get())
      .toEqual({ n: 0 })
  })
})
