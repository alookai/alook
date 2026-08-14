import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateBot } from "../../src/db/queries/community/bot";

describe("bot owner instruction updates", () => {
  let sqlite: Sqlite.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER,
        image TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        isBot INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        deletedAt TEXT,
        discriminator TEXT NOT NULL DEFAULT '0000',
        lastRefreshContextAt TEXT
      );
      CREATE TABLE community_bot_binding (
        user_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        model_name TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_user_profile (
        user_id TEXT PRIMARY KEY,
        about_me TEXT
      );
    `);
    db = drizzle(sqlite);
    (db as any).batch = (statements: Array<{ toSQL: () => { sql: string; params: unknown[] } }>) =>
      sqlite.transaction(() => statements.map((statement) => {
        const query = statement.toSQL();
        const prepared = sqlite.prepare(query.sql);
        return prepared.reader ? prepared.all(...query.params) : prepared.run(...query.params);
      }))();
    const insertUser = sqlite.prepare(`
      INSERT INTO user
        (id, name, email, createdAt, updatedAt, isBot, ownerUserId, discriminator)
      VALUES (?, ?, ?, '2026-01-01', '2026-01-01', ?, ?, '0001')
    `);
    insertUser.run("owner_1", "Owner", "owner@example.com", 0, null);
    insertUser.run("owner_2", "Other", "other@example.com", 0, null);
    insertUser.run("bot_1", "Bot", "bot@example.com", 1, "owner_1");
    sqlite.prepare(`
      INSERT INTO community_bot_binding
        (user_id, machine_id, runtime, instruction, created_at)
      VALUES ('bot_1', 'machine_1', 'codex', 'owner role', '2026-01-01')
    `).run();
    sqlite.prepare(`
      INSERT INTO community_user_profile (user_id, about_me)
      VALUES ('bot_1', 'public bio')
    `).run();
  });

  afterEach(() => sqlite.close());

  it("updates owner-controlled instruction without rewriting public bio", async () => {
    const result = await updateBot(db as never, "bot_1", "owner_1", { description: "new role" });
    expect(result?.description).toBe("new role");
    expect(sqlite.prepare("SELECT instruction FROM community_bot_binding WHERE user_id='bot_1'").get())
      .toEqual({ instruction: "new role" });
    expect(sqlite.prepare("SELECT about_me FROM community_user_profile WHERE user_id='bot_1'").get())
      .toEqual({ about_me: "public bio" });
  });

  it("requires an owner-scoped binding before updating the user row", async () => {
    sqlite.prepare("DELETE FROM community_bot_binding WHERE user_id='bot_1'").run();
    const result = await updateBot(db as never, "bot_1", "owner_1", {
      name: "Renamed",
      description: "new role",
    });
    expect(result).toBeNull();
    expect(sqlite.prepare("SELECT name FROM user WHERE id='bot_1'").get()).toEqual({ name: "Bot" });
  });

  it("keeps both statements owner-scoped", async () => {
    const result = await updateBot(db as never, "bot_1", "owner_2", {
      name: "Stolen",
      description: "stolen role",
    });
    expect(result).toBeNull();
    expect(sqlite.prepare("SELECT name FROM user WHERE id='bot_1'").get()).toEqual({ name: "Bot" });
    expect(sqlite.prepare("SELECT instruction FROM community_bot_binding WHERE user_id='bot_1'").get())
      .toEqual({ instruction: "owner role" });
  });
});
