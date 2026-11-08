import { communityWriteDb } from "../helpers/community-write-db";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("../../src/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as channelQueries from "../../src/db/queries/community/channel";


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
