import { communityWriteDb } from "../helpers/community-write-db";
import { createMigratedDb } from "../helpers/migrated-db";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { communityCategory, communityChannel, communityMessage, communityServer, communityServerMember } from "../../src/db/community-schema";
import { user } from "../../src/db/schema";

vi.mock("../../src/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as channelQueries from "../../src/db/queries/community/channel";
import { resolveScopeMembers } from "../../src/db/queries/community/members-resolver";

it("tracks inherited private channel access and scoped writes on the migrated schema", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    await db.insert(user).values(["owner", "viewer", "outsider"].map(id => ({
      id, name: id, email: id + "@example.test",
    }))).run();
    await db.insert(communityServer).values([
      { id: "studio", name: "Studio", ownerId: "owner" },
      { id: "elsewhere", name: "Elsewhere", ownerId: "owner" },
    ]).run();
    await db.insert(communityServerMember).values({ serverId: "studio", userId: "viewer", role: "admin" }).run();
    await db.insert(communityCategory).values({ id: "private-category", serverId: "studio", name: "Private", private: 1 }).run();
    await db.insert(communityChannel).values([
      { id: "public", name: "public", type: "text", serverId: "studio", position: 0, topic: "public topic" },
      { id: "private", name: "private", type: "text", serverId: "studio", position: 1, categoryId: "private-category", creatorId: "owner" },
      { id: "foreign", name: "foreign", type: "text", serverId: "elsewhere" },
    ]).run();
    await db.insert(communityMessage).values([
      { id: "root-1", authorId: "owner", channelId: "private", seq: 1 },
      { id: "root-2", authorId: "owner", channelId: "private", seq: 2 },
    ]).run();
    await db.insert(communityChannel).values([
      { id: "thread", type: "thread", serverId: "studio", parentChannelId: "private", parentMessageId: "root-1" },
      { id: "archived", type: "thread", serverId: "studio", parentChannelId: "private", parentMessageId: "root-2", archived: 1 },
    ]).run();

    expect((await channelQueries.listServerChannels(db, "studio")).map(row => row.id)).toEqual(["public", "private"]);
    const visible = async () => (await channelQueries.listServerChannelsForViewer(db, "studio", "viewer")).map(row => row.id);
    await expect(visible()).resolves.toEqual(["public"]);
    await expect(resolveScopeMembers(db, "public")).resolves.toEqual([
      { userId: "viewer", role: "admin", source: "admin" },
    ]);
    await expect(channelQueries.resolveChannelAccessContext(db, "thread", "outsider")).resolves.toBeNull();
    await expect(channelQueries.resolveChannelAccessContext(db, "thread", "viewer")).resolves.toMatchObject({
      channel: { id: "thread" }, anchor: { id: "private" }, role: "admin", isPrivate: true, isChannelMember: false,
    });

    const membership = { channelId: "private", userId: "viewer" };
    await channelQueries.createChannelMember(db, { ...membership, relation: "notify" });
    await expect(visible()).resolves.toEqual(["public"]);
    await expect(channelQueries.createChannelMember(db, membership)).resolves.toMatchObject({ ...membership, relation: "access" });
    await expect(channelQueries.createChannelMember(db, membership)).resolves.toBeNull();
    await expect(visible()).resolves.toEqual(["public", "private"]);
    await expect(channelQueries.resolveChannelAccessContext(db, "thread", "viewer")).resolves.toMatchObject({ isChannelMember: true });
    expect((await resolveScopeMembers(db, "thread")).toSorted((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: "owner", role: "member", source: "explicit" },
      { userId: "viewer", role: "admin", source: "explicit" },
    ]);
    await expect(resolveScopeMembers(db, "unknown")).resolves.toEqual([]);
    await expect(channelQueries.deleteChannelMember(db, "private", "viewer")).resolves.toMatchObject({ relation: "access" });
    await expect(channelQueries.isChannelMember(db, "private", "viewer", "notify")).resolves.toBe(true);
    await expect(visible()).resolves.toEqual(["public"]);

    expect((await channelQueries.listChildChannels(db, "private", { archived: false, type: "thread" })).map(row => row.id)).toEqual(["thread"]);
    expect((await channelQueries.getDirectChildThreadsByIds(db, "private", ["public", "thread", "foreign"])).map(row => row.id)).toEqual(["thread"]);
    await expect(channelQueries.updateChannel(db, "private", { topic: "updated topic" })).resolves.toMatchObject({ id: "private", topic: "updated topic" });
    const rows = await channelQueries.getChannelsByIds(db, ["private", "public"]);
    expect(rows.map(row => [row.id, row.topic]).sort()).toEqual([["private", "updated topic"], ["public", "public topic"]]);
  } finally {
    sqlite.close();
  }
});

describe("deleteChannelMemberAndChildParticipants", () => {
  it("batches access removal with child notify cleanup", async () => {
    const handoffStatement: any = {};
    handoffStatement.set = vi.fn(() => handoffStatement);
    handoffStatement.where = vi.fn(() => handoffStatement);
    handoffStatement.returning = vi.fn(() => handoffStatement);
    const accessStatement: any = {};
    accessStatement.where = vi.fn(() => accessStatement);
    accessStatement.returning = vi.fn(() => accessStatement);
    const notifyStatement: any = {};
    notifyStatement.where = vi.fn(() => notifyStatement);
    const selectStatement: any = {};
    selectStatement.from = vi.fn(() => selectStatement);
    selectStatement.where = vi.fn(() => selectStatement);
    const db: any = {
      update: vi.fn(() => handoffStatement),
      delete: vi
        .fn()
        .mockReturnValueOnce(accessStatement)
        .mockReturnValueOnce(notifyStatement),
      select: vi.fn(() => selectStatement),
      batch: vi.fn().mockResolvedValue([[], [{ id: "cm1" }], { rowsAffected: 3 }]),
    };

    await expect(channelQueries.deleteChannelMemberAndChildParticipants(
      db,
      "c1",
      "u2",
    )).resolves.toEqual({ id: "cm1" });

    expect(db.batch).toHaveBeenCalledWith([
      handoffStatement,
      accessStatement,
      notifyStatement,
    ]);
  });
});

describe("canonical scoped channel visibility through real SQLite", () => {
  let fixture: ReturnType<typeof communityWriteDb>;
  beforeEach(() => {
    fixture = communityWriteDb();
    fixture.sqlite.exec(`
      ALTER TABLE community_server_member ADD COLUMN role TEXT;
      INSERT INTO user(id) VALUES ('viewer'), ('creator'), ('outsider');
      INSERT INTO community_server_member(id, server_id, user_id, role) VALUES ('viewer-member', 'server', 'viewer', 'member'), ('creator-member', 'server', 'creator', 'member');
      INSERT INTO community_category(id, private) VALUES ('private', 1);
      INSERT INTO community_channel(id, server_id, category_id, creator_id, type, created_at) VALUES
        ('public', 'server', NULL, 'creator', 'text', 'now'),
        ('private', 'server', 'private', 'creator', 'text', 'now'),
        ('dm', NULL, NULL, NULL, 'dm', 'now');
      INSERT INTO community_channel(id, server_id, parent_channel_id, creator_id, type, created_at) VALUES ('child', 'server', 'private', 'outsider', 'thread', 'now');
    `);
  });
  afterEach(() => fixture.sqlite.close());
  it("admits a public server member, denies an outsider, and returns only channel columns", async () => {
    const channel = await channelQueries.getChannelForMember(fixture.db, 'public', 'viewer');
    expect(channel).toMatchObject({ id: 'public', serverId: 'server' });
    expect(channel).not.toHaveProperty('memberRole');
    expect(await channelQueries.getChannelForMember(fixture.db, 'public', 'outsider')).toBeNull();
  });
  it.each(['member', 'admin', 'owner'])("denies private content to %s without access, then admits an explicit access grant", async role => {
    fixture.sqlite.prepare('UPDATE community_server_member SET role = ? WHERE user_id = ?').run(role, 'viewer');
    for (const id of ['private', 'child']) expect(await channelQueries.getChannelForMember(fixture.db, id, 'viewer')).toBeNull();
    fixture.sqlite.exec("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('notify','private','viewer','notify','now')");
    expect(await channelQueries.getChannelForMember(fixture.db, 'private', 'viewer')).toBeNull();
    fixture.sqlite.exec("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('access','private','viewer','access','now')");
    for (const id of ['private', 'child']) expect(await channelQueries.getChannelForMember(fixture.db, id, 'viewer')).toMatchObject({ id });
  });
  it("inherits the private anchor creator and denies a child creator without anchor access", async () => {
    expect(await channelQueries.getChannelForMember(fixture.db, 'child', 'creator')).toMatchObject({ id: 'child' });
    fixture.sqlite.exec("INSERT INTO community_server_member(id,server_id,user_id) VALUES ('outside-member','server','outsider')");
    expect(await channelQueries.getChannelForMember(fixture.db, 'child', 'outsider')).toBeNull();
  });
  it("requires a DM access relation rather than notification membership", async () => {
    fixture.sqlite.exec("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('dm-notify','dm','viewer','notify','now')");
    expect(await channelQueries.getChannelForMember(fixture.db, 'dm', 'viewer')).toBeNull();
    fixture.sqlite.exec("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('dm-access','dm','viewer','access','now')");
    expect(await channelQueries.getChannelForMember(fixture.db, 'dm', 'viewer')).toMatchObject({ id: 'dm', serverId: null });
  });
});
