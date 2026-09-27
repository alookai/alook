import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db";
import {
  groupChannelRefDirectoryRows,
  listChannelRefDirectoryForUser,
} from "../../src/db/queries/community/channel";

describe("groupChannelRefDirectoryRows", () => {
  it("preserves rail order and includes member servers with no visible channels", () => {
    const result = groupChannelRefDirectoryRows(
      [
        { id: "server_2", name: "Second", discriminator: "0002" },
        { id: "server_1", name: "First", discriminator: "0001" },
      ],
      [
        {
          serverId: "server_1",
          channelId: "channel_1",
          channelName: "general",
          channelType: "text",
        },
        {
          serverId: "server_1",
          channelId: "channel_2",
          channelName: "random",
          channelType: "forum",
        },
      ]
    );

    expect(result).toEqual([
      { id: "server_2", name: "Second", discriminator: "0002", channels: [] },
      {
        id: "server_1",
        name: "First",
        discriminator: "0001",
        channels: [
          { id: "channel_1", name: "general", type: "text" },
          { id: "channel_2", name: "random", type: "forum" },
        ],
      },
    ]);
  });
});

describe("listChannelRefDirectoryForUser", () => {
  let sqlite: Sqlite.Database;
  let db: Database;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_server (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        discriminator TEXT NOT NULL
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        rail_order INTEGER
      );
      CREATE TABLE community_category (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        position INTEGER,
        private INTEGER
      );
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        category_id TEXT,
        name TEXT,
        type TEXT,
        position INTEGER,
        parent_channel_id TEXT,
        creator_id TEXT
      );
      CREATE TABLE community_channel_member (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relation TEXT NOT NULL
      );

      INSERT INTO community_server (id, name, discriminator) VALUES
        ('s1', 'First', '0001'),
        ('s2', 'Second', '0002'),
        ('s3', 'Not joined', '0003');
      INSERT INTO community_server_member (id, server_id, user_id, rail_order) VALUES
        ('sm2', 's2', 'viewer', 0),
        ('sm1', 's1', 'viewer', 1),
        ('sm3', 's3', 'someone_else', 0);
      INSERT INTO community_category (id, server_id, position, private) VALUES
        ('public', 's1', 0, 0),
        ('private', 's1', 1, 1),
        ('private_s2', 's2', 0, 1);
      INSERT INTO community_channel
        (id, server_id, category_id, name, type, position, parent_channel_id, creator_id)
      VALUES
        ('uncategorized', 's1', NULL, 'uncategorized', 'text', 0, NULL, 'other'),
        ('public_channel', 's1', 'public', 'public-channel', 'text', 1, NULL, 'other'),
        ('private_owned', 's1', 'private', 'private-owned', 'forum', 2, NULL, 'viewer'),
        ('private_access', 's1', 'private', 'private-access', 'text', 3, NULL, 'other'),
        ('private_hidden', 's1', 'private', 'private-hidden', 'text', 4, NULL, 'other'),
        ('child_thread', 's1', 'public', 'child-thread', 'thread', 5, 'public_channel', 'viewer'),
        ('s2_hidden', 's2', 'private_s2', 'hidden', 'text', 0, NULL, 'other'),
        ('nonmember_public', 's3', NULL, 'nonmember-public', 'text', 0, NULL, 'other'),
        ('dm', NULL, NULL, NULL, 'dm', 0, NULL, 'viewer');
      INSERT INTO community_channel_member (id, channel_id, user_id, relation) VALUES
        ('cm_access', 'private_access', 'viewer', 'access'),
        ('cm_notify', 'private_hidden', 'viewer', 'notify'),
        ('cm_dm', 'dm', 'viewer', 'access');
    `);
    db = drizzle(sqlite) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("returns one rail-ordered directory scoped to member-visible top-level channels", async () => {
    await expect(listChannelRefDirectoryForUser(db, "viewer")).resolves.toEqual([
      { id: "s2", name: "Second", discriminator: "0002", channels: [] },
      {
        id: "s1",
        name: "First",
        discriminator: "0001",
        channels: [
          { id: "public_channel", name: "public-channel", type: "text" },
          { id: "private_owned", name: "private-owned", type: "forum" },
          { id: "private_access", name: "private-access", type: "text" },
          { id: "uncategorized", name: "uncategorized", type: "text" },
        ],
      },
    ]);
  });
});
