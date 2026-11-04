import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as profileQueries from "../../src/db/queries/community/user-profile";
import type { Database } from "../../src/db";

function createDatabase() {
  const sqlite = new Sqlite(":memory:");
  try {
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE user (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        emailVerified INTEGER, image TEXT, avatarVersion INTEGER NOT NULL DEFAULT 0,
        avatarObjectKey TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        isBot INTEGER NOT NULL DEFAULT 0, ownerUserId TEXT REFERENCES user(id),
        deletedAt TEXT, discriminator TEXT NOT NULL DEFAULT '0000', lastRefreshContextAt TEXT
      );
      CREATE TABLE community_user_profile (
        user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
        about_me TEXT DEFAULT '', banner_color TEXT, status_emoji TEXT, status_text TEXT DEFAULT ''
      );
    `);
    const rawRows: unknown[][] = [];
    const client = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              raw: async () => {
                const rows = sqlite.prepare(sql).raw(true).all(...params) as unknown[][];
                rawRows.push(...rows.map(row => [...row]));
                return rows;
              },
              all: async () => {
                const rows = sqlite.prepare(sql).all(...params) as Record<string, unknown>[];
                rawRows.push(...rows.map(row => Object.values(row)));
                return { success: true, results: rows };
              },
              run: async () => {
                const result = sqlite.prepare(sql).run(...params);
                return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
              },
            };
          },
        };
      },
    };
    const db = drizzle(client as never) as unknown as Database;
    const insertUser = sqlite.prepare(`
      INSERT INTO user
        (id,name,email,image,createdAt,updatedAt,isBot,ownerUserId,deletedAt,discriminator)
      VALUES (?,?,?,?,'2026-01-01','2026-01-01',?,?,?,?)
    `);
    insertUser.run("viewer_1", "Viewer", "viewer@example.com", null, 0, null, null, "0001");
    insertUser.run("human_1", "Human", "human@example.com", "human.png", 0, null, null, "0002");
    insertUser.run("owner_1", "Owner", "owner@example.com", null, 0, null, null, "0042");
    insertUser.run("bot_1", "Helper", "bot@example.com", "bot.png", 1, "owner_1", null, "0100");
    insertUser.run("deleted_target", "Gone", "gone@example.com", null, 0, null, "2026-02-01", "0003");
    insertUser.run("deleted_owner", "Old Owner", "old-owner@example.com", null, 0, null, "2026-02-01", "0004");
    insertUser.run("orphaned_bot", "Orphan", "orphan@example.com", null, 1, "deleted_owner", null, "0101");
    sqlite.prepare(`
      INSERT INTO community_user_profile (user_id,about_me,banner_color,status_emoji,status_text)
      VALUES ('bot_1','backend bot','#123456','🛠️','Working')
    `).run();
    return { sqlite, db, rawRows };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

type Store = ReturnType<typeof createDatabase>;
async function withDatabase(run: (store: Store) => Promise<void>) {
  const store = createDatabase();
  try { await run(store); } finally { store.sqlite.close(); }
}

function seedForeignProfile(sqlite: Sqlite.Database) {
  sqlite.prepare(`
    INSERT INTO community_user_profile (user_id,about_me,banner_color,status_emoji,status_text)
    VALUES ('viewer_1','Keep about','#abcdef','🎧','Keep status')
  `).run();
  return sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='viewer_1'").get();
}

function expectForeignProfile(sqlite: Sqlite.Database, before: unknown) {
  expect(sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='viewer_1'").get()).toEqual(before);
}

describe("getPublicProfileForViewer", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    const store = createDatabase();
    sqlite = store.sqlite;
    db = store.db;
  });
  afterEach(() => { if (sqlite?.open) sqlite.close(); });

  it("returns the human discriminator without bot-only identity fields", async () => {
    sqlite.prepare("UPDATE user SET avatarVersion=9 WHERE id='human_1'").run();
    await expect(profileQueries.getPublicProfileForViewer(db, "human_1", "viewer_1"))
      .resolves.toEqual({
        id: "human_1", name: "Human", discriminator: "0002", image: "human.png",
        avatarVersion: 9, aboutMe: "", bannerColor: null, statusEmoji: null,
        statusText: null, identity: { kind: "human" },
      });
  });

  it.each([null, "", "Busy"])("preserves explicit status %s through actual insert and public SQL read", async statusText => {
    await profileQueries.updateProfile(db, "human_1", { statusEmoji: null, statusText })
    expect(sqlite.prepare("SELECT status_text FROM community_user_profile WHERE user_id=?").get("human_1")).toEqual({ status_text: statusText })
    expect((await profileQueries.getPublicProfileForViewer(db, "human_1", "viewer_1"))?.statusText).toBe(statusText)
  });

  it("returns canonical public owner navigation and SQL-derived viewer ownership", async () => {
    sqlite.prepare("UPDATE user SET avatarVersion=7 WHERE id='bot_1'").run();
    const ownerView = await profileQueries.getPublicProfileForViewer(db, "bot_1", "owner_1");
    expect(ownerView).toEqual({
      id: "bot_1", name: "Helper", discriminator: "0100", image: "bot.png",
      avatarVersion: 7, aboutMe: "backend bot", bannerColor: "#123456",
      statusEmoji: "🛠️", statusText: "Working",
      identity: { kind: "bot", ownerProfile: { id: "owner_1", handle: "Owner#0042" }, ownedByViewer: true },
    });
    const otherView = await profileQueries.getPublicProfileForViewer(db, "bot_1", "viewer_1");
    expect(otherView?.identity).toEqual({
      kind: "bot", ownerProfile: { id: "owner_1", handle: "Owner#0042" }, ownedByViewer: false,
    });
    expect(otherView).not.toHaveProperty("ownerUserId");
    expect(otherView).not.toHaveProperty("email");
  });

  it("does not resolve a soft-deleted target or a bot whose owner is soft-deleted", async () => {
    await expect(profileQueries.getPublicProfileForViewer(db, "deleted_target", "viewer_1"))
      .resolves.toBeNull();
    await expect(profileQueries.getPublicProfileForViewer(db, "orphaned_bot", "viewer_1"))
      .resolves.toBeNull();
  });
});

describe("getProfile", () => {
  it("returns the actual stored profile including status fields", async () => {
    await withDatabase(async store => {
      seedForeignProfile(store.sqlite);
      await expect(profileQueries.getProfile(store.db, "bot_1")).resolves.toEqual({
        userId: "bot_1", aboutMe: "backend bot", bannerColor: "#123456", statusEmoji: "🛠️", statusText: "Working",
      });
      expect(new Set(store.rawRows.flat()).has("viewer_1")).toBe(false);
    });
  });

  it("returns null for a valid user without a profile despite another stored profile", async () => {
    await withDatabase(async store => {
      await expect(profileQueries.getProfile(store.db, "human_1")).resolves.toBeNull();
      expect(store.rawRows).toEqual([]);
    });
  });
});

describe("updateProfile", () => {
  it("inserts the supplied status and about fields for only the requested user", async () => {
    await withDatabase(async store => {
      const foreign = seedForeignProfile(store.sqlite);
      const beforeBot = store.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='bot_1'").get();
      await expect(profileQueries.updateProfile(store.db, "human_1", { aboutMe: "hi", statusEmoji: "🎧", statusText: "Vibing" })).resolves.toEqual({
        userId: "human_1", aboutMe: "hi", bannerColor: null, statusEmoji: "🎧", statusText: "Vibing",
      });
      expect(store.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='human_1'").get()).toEqual({
        user_id: "human_1", about_me: "hi", banner_color: null, status_emoji: "🎧", status_text: "Vibing",
      });
      expect(store.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='bot_1'").get()).toEqual(beforeBot);
      expectForeignProfile(store.sqlite, foreign);
      expect(store.sqlite.prepare("SELECT count(*) AS count FROM community_user_profile").get()).toEqual({ count: 3 });
    });
  });

  it("persists an about-only patch without changing status or another profile", async () => {
    await withDatabase(async store => {
      const foreign = seedForeignProfile(store.sqlite);
      const result = await profileQueries.updateProfile(store.db, "bot_1", { aboutMe: "hi" });
      expect(store.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='bot_1'").get()).toEqual({
        user_id: "bot_1", about_me: "hi", banner_color: "#123456", status_emoji: "🛠️", status_text: "Working",
      });
      expect(result).toEqual({ userId: "bot_1", aboutMe: "hi", bannerColor: "#123456", statusEmoji: "🛠️", statusText: "Working" });
      expectForeignProfile(store.sqlite, foreign);
      expect(store.sqlite.prepare("SELECT count(*) AS count FROM community_user_profile").get()).toEqual({ count: 2 });
    });
  });

  it("updates status while preserving existing about and banner facts", async () => {
    await withDatabase(async store => {
      const foreign = seedForeignProfile(store.sqlite);
      await expect(profileQueries.updateProfile(store.db, "bot_1", { statusEmoji: "🎮", statusText: "Gaming" })).resolves.toEqual({
        userId: "bot_1", aboutMe: "backend bot", bannerColor: "#123456", statusEmoji: "🎮", statusText: "Gaming",
      });
      expect(store.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='bot_1'").get()).toEqual({
        user_id: "bot_1", about_me: "backend bot", banner_color: "#123456", status_emoji: "🎮", status_text: "Gaming",
      });
      expectForeignProfile(store.sqlite, foreign);
    });
  });

  it("clears an existing nonnull status without overwriting other profile fields", async () => {
    await withDatabase(async store => {
      const foreign = seedForeignProfile(store.sqlite);
      await expect(profileQueries.updateProfile(store.db, "bot_1", { statusEmoji: null, statusText: null })).resolves.toEqual({
        userId: "bot_1", aboutMe: "backend bot", bannerColor: "#123456", statusEmoji: null, statusText: null,
      });
      expect(store.sqlite.prepare("SELECT * FROM community_user_profile WHERE user_id='bot_1'").get()).toEqual({
        user_id: "bot_1", about_me: "backend bot", banner_color: "#123456", status_emoji: null, status_text: null,
      });
      expectForeignProfile(store.sqlite, foreign);
    });
  });
});
