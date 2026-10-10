import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachment, getReadableAttachmentById, listMessageAttachments } from "../../src/db/queries/community/attachment";
import { createMessage, isMessageAttachmentConflict } from "../../src/db/queries/community/message";
import { communityWriteDb } from "../helpers/community-write-db";

describe("reusable files with real SQLite authorization and transactions", () => {
  let fixture: ReturnType<typeof communityWriteDb>;
  beforeEach(() => {
    fixture = communityWriteDb();
    fixture.sqlite.exec(`
      INSERT INTO user(id) VALUES ('recipient'), ('stranger');
      UPDATE community_channel SET server_id = 's1' WHERE id = 'channel';
      INSERT INTO community_channel(id, server_id, type, created_at) VALUES ('destination', 's2', 'text', 'now');
      INSERT INTO community_server_member VALUES ('1','s1','author'), ('2','s1','peer'), ('3','s2','peer'), ('4','s2','recipient');
    `);
  });
  afterEach(() => fixture.sqlite.close());
  const upload = (id: string, overrides = {}) => createAttachment(fixture.db, {
    id, uploaderId: "author", filename: `${id}.pdf`, r2Key: "attachments/sha256/shared", size: 3, ...overrides,
  });
  const send = (authorId: string, channelId: string, attachmentIds: string[], overrides = {}) =>
    createMessage(fixture.db, { authorId, content: "file", channelId, attachmentIds, ...overrides });
  const read = (id: string, userId: string) => getReadableAttachmentById(fixture.db, id, userId);

  it("an unsent file is private until a valid actor forwards its known ID", async () => {
    await upload("a");
    expect(await read("a", "author")).toMatchObject({ id: "a" });
    expect(await read("a", "peer")).toBeNull();
    expect(await read("missing", "author")).toBeNull();
    await send("peer", "destination", ["a"]);
    expect(await read("a", "peer")).not.toBeNull();
    expect(await read("a", "recipient")).not.toBeNull();
    expect(await read("a", "stranger")).toBeNull();
  });

  it("an upload finishing after uploader deletion cannot create a dead-owner file", async () => {
    fixture.sqlite.exec("UPDATE user SET deletedAt = 'now' WHERE id = 'author'");
    await expect(upload("deleted")).rejects.toThrow("uploader no longer exists");
    fixture.sqlite.exec("DELETE FROM user WHERE id = 'author'");
    await expect(upload("missing")).rejects.toThrow("uploader no longer exists");
    expect(fixture.sqlite.prepare("SELECT * FROM community_attachment").all()).toEqual([]);
  });

  it("forwards the same ID across servers and preserves each message's order", async () => {
    await upload("a"); await upload("b", { filename: "other.pdf" });
    const source = await send("author", "channel", ["a", "b"]);
    const copies = await Promise.all([send("peer", "destination", ["b", "a"]), send("peer", "destination", ["a"])]);
    expect((await listMessageAttachments(fixture.db, source!.id)).map(r => r.id)).toEqual(["a", "b"]);
    expect((await listMessageAttachments(fixture.db, copies[0]!.id)).map(r => r.id)).toEqual(["b", "a"]);
    expect(await read("a", "recipient")).toMatchObject({ filename: "a.pdf" });
    expect(await read("a", "stranger")).toBeNull();
    fixture.sqlite.prepare("DELETE FROM community_message WHERE id = ?").run(source!.id);
    expect(await read("a", "recipient")).not.toBeNull();
    fixture.sqlite.prepare("DELETE FROM community_message WHERE channel_id = 'destination'").run();
    expect(await read("a", "author")).toBeNull();
    expect(await read("b", "author")).toBeNull();
  });

  it("source revocation does not block forwarding a known ID", async () => {
    await upload("a"); await send("author", "channel", ["a"]);
    expect(await read("a", "peer")).not.toBeNull();
    const batch = fixture.db.batch.bind(fixture.db);
    fixture.db.batch = ((statements: any[]) => {
      fixture.sqlite.exec("DELETE FROM community_server_member WHERE server_id = 's1' AND user_id = 'peer'");
      return batch(statements as any);
    }) as any;
    await send("peer", "destination", ["a"]);
    expect(fixture.sqlite.prepare("SELECT * FROM community_server_member WHERE server_id = 's1' AND user_id = 'peer'").all()).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT * FROM community_message WHERE channel_id = 'destination'").all()).toHaveLength(1);
    expect(fixture.sqlite.prepare("SELECT * FROM community_message_seq WHERE channel_id = 'destination'").all()).toEqual([{ channel_id: "destination", next_seq: 1 }]);
    expect(await read("a", "recipient")).not.toBeNull();
  });

  it("last-reference deletion invalidates a known ID before forwarding", async () => {
    await upload("a"); const source = await send("author", "channel", ["a"]);
    expect(await read("a", "peer")).not.toBeNull();
    fixture.sqlite.prepare("DELETE FROM community_message WHERE id = ?").run(source!.id);
    const error = await send("peer", "destination", ["a"]).catch(e => e);
    expect(isMessageAttachmentConflict(error)).toBe(true);
    expect(fixture.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    await upload("draft");
    fixture.sqlite.exec("DELETE FROM community_channel WHERE id = 'destination'");
    expect(await read("draft", "author")).not.toBeNull();
  });

  it("a deleted actor cannot retain uploader or source access while another reader can use the file", async () => {
    await upload("a"); await send("author", "channel", ["a"]);
    await send("peer", "destination", ["a"]);
    fixture.sqlite.exec("UPDATE user SET deletedAt = 'now' WHERE id = 'author'");
    expect(await read("a", "author")).toBeNull();
    expect(await read("a", "recipient")).not.toBeNull();
    fixture.sqlite.exec("UPDATE user SET deletedAt = 'now' WHERE id = 'peer'");
    expect(await read("a", "peer")).toBeNull();
    const error = await send("peer", "destination", ["a"]).catch(e => e);
    expect(isMessageAttachmentConflict(error)).toBe(true);
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM community_message WHERE channel_id = 'destination'").get()).toEqual({ count: 1 });
  });

  it("private forum children inherit the parent access roster; removal takes effect", async () => {
    await upload("a");
    fixture.sqlite.exec(`
      INSERT INTO community_category VALUES ('private', 1);
      UPDATE community_channel SET category_id = 'private', type = 'forum', creator_id = 'author' WHERE id = 'channel';
      INSERT INTO community_channel(id, server_id, type, parent_channel_id, created_at) VALUES ('thread','s1','thread','channel','now');
    `);
    await send("author", "thread", ["a"]);
    expect(await read("a", "peer")).toBeNull();
    fixture.sqlite.exec("INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('private-access','channel','peer','access','now')");
    expect(await read("a", "peer")).not.toBeNull();
    fixture.sqlite.exec("DELETE FROM community_channel_member WHERE id = 'private-access'");
    expect(await read("a", "peer")).toBeNull();
  });

  it("DM participant access and either direction of blocking apply to file readers", async () => {
    await upload("a");
    fixture.sqlite.exec(`
      INSERT INTO community_channel(id,type,created_at) VALUES ('dm','dm','now');
      INSERT INTO community_channel_member(id,channel_id,user_id,relation,added_at) VALUES ('dm-a','dm','author','access','now'), ('dm-p','dm','peer','access','now');
    `);
    await send("author", "dm", ["a"]);
    expect(await read("a", "peer")).not.toBeNull();
    fixture.sqlite.exec("INSERT INTO community_friendship VALUES ('block','author','peer','blocked')");
    expect(await read("a", "peer")).toBeNull();
    fixture.sqlite.exec("UPDATE community_friendship SET requester_id = 'peer', addressee_id = 'author'");
    expect(await read("a", "peer")).toBeNull();
    expect(await read("a", "author")).not.toBeNull();
  });

  it("file metadata and shared keys are independent, and unreferenced drafts survive other deletion", async () => {
    const a = await upload("a", { thumbnailR2Key: "attachment-thumbnails/sha256/first" });
    const b = await upload("b", { filename: "renamed.pdf", thumbnailR2Key: "attachment-thumbnails/sha256/second" });
    expect(a.id).not.toBe(b.id); expect(a.r2Key).toBe(b.r2Key);
    const source = await send("author", "channel", ["a"]);
    fixture.sqlite.prepare("DELETE FROM community_message WHERE id = ?").run(source!.id);
    expect(await read("a", "author")).toBeNull();
    expect(await read("b", "author")).toMatchObject({ filename: "renamed.pdf", r2Key: a.r2Key });
  });
});
