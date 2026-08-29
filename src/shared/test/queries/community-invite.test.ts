import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInvite, useInvite } from "../../src/db/queries/community/invite";

describe("community invite quota consumption", () => {
  let sqlite: Sqlite.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0,
        avatarObjectKey TEXT,
        discriminator TEXT
      );
      CREATE TABLE community_server_invite (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        created_by TEXT,
        token TEXT NOT NULL UNIQUE,
        max_uses INTEGER,
        uses INTEGER DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        rail_order INTEGER DEFAULT 0,
        joined_at TEXT NOT NULL,
        UNIQUE(server_id, user_id)
      );
    `);
    db = drizzle(sqlite);
    // better-sqlite3's Drizzle adapter has transactions but no D1-style batch.
    // Execute the generated statements in one native SQLite transaction so the
    // query's all-or-nothing quota contract is exercised against real SQL.
    (db as any).batch = (statements: Array<{ toSQL: () => { sql: string; params: unknown[] } }>) =>
      sqlite.transaction(() =>
        statements.map((statement) => {
          const query = statement.toSQL();
          const prepared = sqlite.prepare(query.sql);
          return prepared.reader
            ? prepared.all(...query.params)
            : prepared.run(...query.params);
        }),
      )();
    sqlite.prepare("INSERT INTO user (id, name, discriminator) VALUES (?, ?, ?)").run("u1", "One", "0001");
    sqlite.prepare("INSERT INTO user (id, name, discriminator) VALUES (?, ?, ?)").run("u2", "Two", "0002");
  });

  afterEach(() => sqlite.close());

  function seedInvite(maxUses: number | null = 1) {
    sqlite.prepare(`
      INSERT INTO community_server_invite
        (id, server_id, created_by, token, max_uses, uses, created_at)
      VALUES ('iv1', 's1', 'owner', 'token1', ?, 0, '2026-01-01T00:00:00.000Z')
    `).run(maxUses);
  }

  it("admits only one member for the final finite use", async () => {
    seedInvite(1);
    await expect(useInvite(db as never, "token1", "u1")).resolves.not.toBeNull();
    await expect(useInvite(db as never, "token1", "u2")).resolves.toBeNull();

    expect(sqlite.prepare("SELECT uses FROM community_server_invite WHERE id='iv1'").get())
      .toEqual({ uses: 1 });
    expect(sqlite.prepare("SELECT user_id FROM community_server_member ORDER BY user_id").all())
      .toEqual([{ user_id: "u1" }]);
  });

  it("rolls the counter back when the membership UNIQUE constraint rejects", async () => {
    seedInvite(null);
    await useInvite(db as never, "token1", "u1");
    await expect(useInvite(db as never, "token1", "u1")).rejects.toThrow();

    expect(sqlite.prepare("SELECT uses FROM community_server_invite WHERE id='iv1'").get())
      .toEqual({ uses: 1 });
  });

  it("enforces the active invite cap inside the insert statement", async () => {
    seedInvite(null);

    await expect(createInvite(db as never, {
      serverId: "s1",
      createdBy: "u1",
      maxActive: 1,
    })).resolves.toBeNull();

    expect(sqlite.prepare("SELECT count(*) AS count FROM community_server_invite WHERE server_id='s1'").get())
      .toEqual({ count: 1 });
  });
});
