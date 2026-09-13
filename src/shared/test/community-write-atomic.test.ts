import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createMessage, isMessageAttachmentConflict } from "../src/db/queries/community/message";
import { createChannel } from "../src/db/queries/community/channel";
import { createOrGetDM } from "../src/db/queries/community/dm";
import { communityWriteDb } from "./helpers/community-write-db";

describe("Community durable writes — real SQLite transactions", () => {
  let fixture: ReturnType<typeof communityWriteDb>;
  beforeEach(() => { fixture = communityWriteDb(); });
  afterEach(() => { fixture.sqlite.close(); });
  const send = (overrides = {}) => createMessage(fixture.db, {
    authorId: "author", authorKind: "human", content: "hello", channelId: "channel", ...overrides,
  });
  const rows = (table: string) => fixture.sqlite.prepare(`SELECT * FROM ${table}`).all();
  const activity = sqliteTable("activity", { sent: integer("sent").notNull() });
  const bump = () => fixture.db.update(activity).set({ sent: sql`${activity.sent} + 1` });

  it("rolls back a new ordinary thread when an initial participant insert fails", async () => {
    const root = await send();
    const data = { serverId: "server", parentChannelId: "channel", parentMessageId: root!.id,
      name: "thread", type: "thread", creatorId: "author",
      initialParticipants: [{ userId: "author", source: "spoke" as const }, { userId: "peer", source: "added" as const }] };
    fixture.sqlite.exec("CREATE TRIGGER fail_seed BEFORE INSERT ON community_channel_member WHEN NEW.user_id = 'peer' BEGIN SELECT RAISE(ABORT, 'seed failed'); END");
    await expect(createChannel(fixture.db, data)).rejects.toThrow("seed failed");
    expect(rows("community_channel")).toHaveLength(1);
    expect(rows("community_channel_member")).toEqual([]);
    fixture.sqlite.exec("DROP TRIGGER fail_seed");
    const thread = await createChannel(fixture.db, data);
    expect(rows("community_channel_member")).toHaveLength(2);
    expect(rows("community_channel_member")).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel_id: thread.id, user_id: "author", source: "spoke", relation: "notify" }),
      expect.objectContaining({ channel_id: thread.id, user_id: "peer", source: "added", relation: "notify" }),
    ]));
    await expect(createChannel(fixture.db, data)).rejects.toThrow();
    expect(rows("community_channel")).toHaveLength(2);
    expect(rows("community_channel_member")).toHaveLength(2);
  });

  it("bounds attachment input and keeps maximum-size statements below D1's bind limit", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `attachment-${i}`);
    const pending = Array.from({ length: 10 }, (_, i) => `pending-${i}`);
    for (const id of [...ids, ...pending]) fixture.sqlite.prepare("INSERT INTO community_attachment (id, uploader_id, target_id) VALUES (?, 'author', 'channel')").run(id);
    const forumThread = { id: "post", serverId: "server", name: "post", pendingAttachmentIds: pending };
    await expect(send({ attachmentIds: [...ids, "extra"] })).rejects.toThrow("too many message attachments");
    await expect(send({ forumThread: { ...forumThread, pendingAttachmentIds: [...pending, "extra"] } })).rejects.toThrow("too many message attachments");
    expect(rows("community_message")).toEqual([]);
    await send({ attachmentIds: ids, forumThread });
    expect(Math.max(...fixture.batchSizes.flat())).toBeLessThanOrEqual(100);
    expect(rows("community_attachment").filter((row: any) => row.message_id)).toHaveLength(10);
  });

  it("rejects stale seq in a deletion hole without any writes", async () => {
    await send();
    await send();
    fixture.sqlite.exec("DELETE FROM community_message WHERE seq = 1");
    const tables = ["community_message", "community_message_seq", "community_channel", "community_read_state", "community_read_state_revision", "activity"];
    const before = tables.map(rows);
    await expect(send({ expectedSeq: 0, extraStatements: [bump()] })).resolves.toBeNull();
    expect(tables.map(rows)).toEqual(before);
    await expect(send({ expectedSeq: 7 })).resolves.toBeNull();
    expect(tables.map(rows)).toEqual(before);
    expect((await send())!.seq).toBe(3);
  });

  it("rejects an ahead-of-counter claim even before the counter exists", async () => {
    await expect(send({ expectedSeq: 1 })).resolves.toBeNull();
    expect(rows("community_message_seq")).toEqual([]);
    expect(rows("community_message")).toEqual([]);
  });

  it("concurrent ordinary sends use distinct increasing seqs", async () => {
    const messages = await Promise.all(Array.from({ length: 12 }, () => send()));
    expect(messages.map((message) => message!.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(rows("community_channel")[0]).toMatchObject({ message_count: 12 });
  });

  it("concurrent reversed user-pair DM opens create one channel and two members", async () => {
    const channels = await Promise.all(Array.from({ length: 12 }, (_, i) => createOrGetDM(fixture.db, {
      userId1: i % 2 ? "author" : "peer", userId2: i % 2 ? "peer" : "author",
    })));
    expect(new Set(channels.map((channel) => channel.id)).size).toBe(1);
    expect(rows("community_channel")).toHaveLength(2);
    expect(rows("community_channel_member")).toHaveLength(2);
    const existing = await createOrGetDM(fixture.db, { userId1: "peer", userId2: "author" });
    expect(existing.id).toBe(channels[0]!.id);
  });

  it("a failed second DM membership leaves no orphan channel or first member", async () => {
    await expect(createOrGetDM(fixture.db, { userId1: "author", userId2: "missing" })).rejects.toThrow();
    expect(rows("community_channel")).toHaveLength(1);
    expect(rows("community_channel_member")).toEqual([]);
  });

  it("commits attachments, mentions, participants and activity together; nonce collision rolls back", async () => {
    fixture.sqlite.exec("INSERT INTO community_attachment VALUES ('a', 'author', 'channel', NULL, 0)");
    const message = await send({
      clientNonce: "nonce", attachmentIds: ["a"], mentions: [{ userId: "peer", kind: "mention" }],
      participants: [{ userId: "author", source: "spoke" }, { userId: "peer", source: "mention" }], extraStatements: [bump()],
    });
    expect(rows("community_attachment")[0]).toMatchObject({ message_id: message!.id });
    expect(rows("community_mention")).toHaveLength(1);
    expect(rows("community_channel_member")).toHaveLength(2);
    await expect(send({ clientNonce: "nonce", extraStatements: [bump()] })).rejects.toThrow();
    expect(rows("activity")).toEqual([{ sent: 1 }]);
    expect(rows("community_message_seq")).toEqual([{ channel_id: "channel", next_seq: 1 }]);
  });

  it("rejects missing, foreign and already reserved attachments without partial writes", async () => {
    fixture.sqlite.exec("INSERT INTO community_attachment VALUES ('a', 'author', 'channel', NULL, 0), ('foreign', 'peer', 'channel', NULL, 0)");
    for (const ids of [["a", "missing"], ["a", "foreign"], ["a", "a"]]) {
      const error = await send({ attachmentIds: ids }).catch((error) => error);
      expect(isMessageAttachmentConflict(error)).toBe(true);
      expect(rows("community_message")).toEqual([]);
      expect(rows("community_message_seq")).toEqual([]);
    }
    await send({ attachmentIds: ["a"] });
    await expect(send({ attachmentIds: ["a"] })).rejects.toThrow();
    expect(rows("community_message")).toHaveLength(1);
  });

  it("a later mention chunk failure rolls back all chunks and same nonce can retry", async () => {
    fixture.sqlite.exec(Array.from({ length: 100 }, (_, i) => `INSERT INTO user VALUES ('u${i}');`).join("\n"));
    const mentions = Array.from({ length: 100 }, (_, i) => ({ userId: `u${i}`, kind: "mention" }));
    fixture.sqlite.exec("CREATE TRIGGER fail_late_mention BEFORE INSERT ON community_mention WHEN NEW.user_id = 'u85' BEGIN SELECT RAISE(ABORT, 'injected mention failure'); END");
    const data = { clientNonce: "retry", mentions, extraStatements: [bump()] };
    await expect(send(data)).rejects.toThrow("injected mention failure");
    for (const table of ["community_message", "community_message_seq", "community_mention", "community_read_state", "community_read_state_revision"]) expect(rows(table)).toEqual([]);
    expect(rows("activity")).toEqual([{ sent: 0 }]);
    fixture.sqlite.exec("DROP TRIGGER fail_late_mention");
    await send(data);
    expect(rows("community_mention")).toHaveLength(100);
    expect(fixture.batchSizes.flat().every((size) => size <= 100)).toBe(true);
  });

  it("forum structure and pending rebind failure rolls back opener, activity and nonce", async () => {
    fixture.sqlite.exec("INSERT INTO community_attachment VALUES ('a', 'author', 'channel', NULL, 0)");
    fixture.sqlite.exec("CREATE TRIGGER fail_rebind BEFORE UPDATE OF target_id ON community_attachment BEGIN SELECT RAISE(ABORT, 'injected rebind failure'); END");
    const data = { clientNonce: "forum", forumThread: { id: "thread", name: "title", serverId: "server", pendingAttachmentIds: ["a"] }, extraStatements: [bump()] };
    await expect(send(data)).rejects.toThrow("injected rebind failure");
    expect(rows("community_message")).toEqual([]);
    expect(rows("community_channel")).toHaveLength(1);
    expect(rows("community_channel_member")).toEqual([]);
    expect(rows("activity")).toEqual([{ sent: 0 }]);
    fixture.sqlite.exec("DROP TRIGGER fail_rebind");
    const message = await send(data);
    expect(rows("community_channel")[1]).toMatchObject({ parent_message_id: message!.id, type: "thread" });
    expect(rows("community_attachment")[0]).toMatchObject({ target_id: "thread", message_id: null });
    expect(rows("activity")).toEqual([{ sent: 1 }]);
  });
  it("later participant chunk failure rolls back the send and all earlier memberships", async () => {
    fixture.sqlite.exec(Array.from({ length: 100 }, (_, i) => `INSERT INTO user VALUES ('u${i}');`).join("\n"));
    fixture.sqlite.exec("CREATE TRIGGER fail_late_participant BEFORE INSERT ON community_channel_member WHEN NEW.user_id = 'u85' BEGIN SELECT RAISE(ABORT, 'injected participant failure'); END");
    const participants = Array.from({ length: 100 }, (_, i) => ({ userId: `u${i}`, source: "mention" }));
    await expect(send({ participants })).rejects.toThrow("injected participant failure");
    expect(rows("community_channel_member")).toEqual([]);
    expect(rows("community_message")).toEqual([]);
    expect(rows("community_read_state")).toEqual([]);
    fixture.sqlite.exec("DROP TRIGGER fail_late_participant");
    await send({ participants });
    expect(rows("community_channel_member")).toHaveLength(100);
    expect(fixture.batchSizes.flat().every((size) => size <= 100)).toBe(true);
  });

  it("an attachment write failure rolls back the message, author cursor, counter and sent count", async () => {
    fixture.sqlite.exec("INSERT INTO community_attachment VALUES ('a', 'author', 'channel', NULL, 0)");
    fixture.sqlite.exec("CREATE TRIGGER fail_attachment BEFORE UPDATE OF message_id ON community_attachment BEGIN SELECT RAISE(ABORT, 'injected attachment failure'); END");
    await expect(send({ attachmentIds: ["a"], extraStatements: [bump()] })).rejects.toThrow("injected attachment failure");
    for (const table of ["community_message", "community_message_seq", "community_read_state", "community_read_state_revision"]) expect(rows(table)).toEqual([]);
    expect(rows("activity")).toEqual([{ sent: 0 }]);
    expect(rows("community_attachment")[0]).toMatchObject({ message_id: null });
  });

});
