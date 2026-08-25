import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as profileQueries from "../../src/db/queries/community/user-profile";
import { communityUserProfile } from "../../src/db/community-schema";
import type { Database } from "../../src/db";

function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createUpsertMock(returnRow: any) {
  const chain: any = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.onConflictDoUpdate = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve([returnRow]));
  return chain;
}

describe("community/user-profile exports", () => {
  it("exports public profile + getProfile + updateProfile queries", () => {
    expect(typeof profileQueries.getPublicProfileForViewer).toBe("function");
    expect(typeof profileQueries.getProfile).toBe("function");
    expect(typeof profileQueries.updateProfile).toBe("function");
  });
});

describe("getPublicProfileForViewer", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

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
      CREATE TABLE community_user_profile (
        user_id TEXT PRIMARY KEY,
        about_me TEXT DEFAULT '',
        banner_color TEXT,
        status_emoji TEXT,
        status_text TEXT DEFAULT ''
      );
    `);
    db = drizzle(sqlite) as unknown as Database;

    const insertUser = sqlite.prepare(`
      INSERT INTO user
        (id, name, email, image, createdAt, updatedAt, isBot, ownerUserId, deletedAt, discriminator)
      VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01', ?, ?, ?, ?)
    `);
    insertUser.run("viewer_1", "Viewer", "viewer@example.com", null, 0, null, null, "0001");
    insertUser.run("human_1", "Human", "human@example.com", "human.png", 0, null, null, "0002");
    insertUser.run("owner_1", "Owner", "owner@example.com", null, 0, null, null, "0042");
    insertUser.run("bot_1", "Helper", "bot@example.com", "bot.png", 1, "owner_1", null, "0100");
    insertUser.run("deleted_target", "Gone", "gone@example.com", null, 0, null, "2026-02-01", "0003");
    insertUser.run("deleted_owner", "Old Owner", "old-owner@example.com", null, 0, null, "2026-02-01", "0004");
    insertUser.run("orphaned_bot", "Orphan", "orphan@example.com", null, 1, "deleted_owner", null, "0101");

    sqlite.prepare(`
      INSERT INTO community_user_profile
        (user_id, about_me, banner_color, status_emoji, status_text)
      VALUES ('bot_1', 'backend bot', '#123456', '🛠️', 'Working')
    `).run();
  });

  afterEach(() => sqlite.close());

  it("returns the human discriminator without bot-only identity fields", async () => {
    await expect(profileQueries.getPublicProfileForViewer(db, "human_1", "viewer_1"))
      .resolves.toEqual({
        id: "human_1",
        name: "Human",
        discriminator: "0002",
        image: "human.png",
        aboutMe: "",
        bannerColor: null,
        statusEmoji: null,
        statusText: "",
        identity: { kind: "human" },
      });
  });

  it("returns canonical public owner navigation and SQL-derived viewer ownership", async () => {
    const ownerView = await profileQueries.getPublicProfileForViewer(db, "bot_1", "owner_1");
    expect(ownerView).toEqual({
      id: "bot_1",
      name: "Helper",
      discriminator: "0100",
      image: "bot.png",
      aboutMe: "backend bot",
      bannerColor: "#123456",
      statusEmoji: "🛠️",
      statusText: "Working",
      identity: {
        kind: "bot",
        ownerProfile: { id: "owner_1", handle: "Owner#0042" },
        ownedByViewer: true,
      },
    });

    const otherView = await profileQueries.getPublicProfileForViewer(db, "bot_1", "viewer_1");
    expect(otherView?.identity).toEqual({
      kind: "bot",
      ownerProfile: { id: "owner_1", handle: "Owner#0042" },
      ownedByViewer: false,
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
  it("returns the row including statusEmoji/statusText when a profile exists", async () => {
    const db = createSelectMock([
      { userId: "u_1", aboutMe: "hi", bannerColor: null, statusEmoji: "🎧", statusText: "Vibing" },
    ]);
    const result = await profileQueries.getProfile(db, "u_1");
    expect(result).toMatchObject({ statusEmoji: "🎧", statusText: "Vibing" });
  });

  it("returns null when no profile row exists", async () => {
    const db = createSelectMock([]);
    const result = await profileQueries.getProfile(db, "u_missing");
    expect(result).toBeNull();
  });
});

describe("updateProfile", () => {
  it("persists statusEmoji/statusText alongside aboutMe on insert", async () => {
    const db = createUpsertMock({
      userId: "u_1",
      aboutMe: "hi",
      bannerColor: null,
      statusEmoji: "🎧",
      statusText: "Vibing",
    });
    const result = await profileQueries.updateProfile(db, "u_1", {
      aboutMe: "hi",
      statusEmoji: "🎧",
      statusText: "Vibing",
    });
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1", aboutMe: "hi", statusEmoji: "🎧", statusText: "Vibing" }),
    );
    expect(result).toMatchObject({ statusEmoji: "🎧", statusText: "Vibing" });
  });

  it("an aboutMe-only update's onConflictDoUpdate.set omits statusEmoji/statusText entirely", async () => {
    const db = createUpsertMock({ userId: "u_1", aboutMe: "hi", bannerColor: null, statusEmoji: null, statusText: "" });
    await profileQueries.updateProfile(db, "u_1", { aboutMe: "hi" });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set).not.toHaveProperty("statusEmoji");
    expect(conflictArg.set).not.toHaveProperty("statusText");
    expect(conflictArg.set).toMatchObject({ aboutMe: "hi" });
    expect(conflictArg.target).toBe(communityUserProfile.userId);
  });

  it("a status-only update's onConflictDoUpdate.set omits aboutMe/bannerColor entirely", async () => {
    const db = createUpsertMock({ userId: "u_1", aboutMe: "", bannerColor: null, statusEmoji: "🎮", statusText: "Gaming" });
    await profileQueries.updateProfile(db, "u_1", { statusEmoji: "🎮", statusText: "Gaming" });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set).not.toHaveProperty("aboutMe");
    expect(conflictArg.set).not.toHaveProperty("bannerColor");
    expect(conflictArg.set).toMatchObject({ statusEmoji: "🎮", statusText: "Gaming" });
  });

  it("clearing statusEmoji/statusText to null writes null through to set", async () => {
    const db = createUpsertMock({ userId: "u_1", aboutMe: "", bannerColor: null, statusEmoji: null, statusText: null });
    await profileQueries.updateProfile(db, "u_1", { statusEmoji: null, statusText: null });
    const conflictArg = db.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.set).toMatchObject({ statusEmoji: null, statusText: null });
  });
});
