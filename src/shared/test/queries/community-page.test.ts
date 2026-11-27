import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedDb } from "../helpers/migrated-db";
import { assertNoBusinessTableScans, type BoundQuery, queryPlan } from "../helpers/query-plan";
import { createAttachment, getOwnedAttachmentById } from "../../src/db/queries/community/attachment";
import { consumePageViewerTicket, createPageViewerTicket, getReadablePage, getReadablePageForArtifact, pageBindingStatement } from "../../src/db/queries/community/page";

describe("Page bindings use current message access", () => {
  let store: ReturnType<typeof createMigratedDb>;
  let reads: BoundQuery[];
  beforeEach(() => {
    reads = [];
    store = createMigratedDb({ logQuery(sql, params) { reads.push({ sql, params }); } });
    const { sqlite } = store;
    for (const id of ["owner", "bot", "reader", "outsider"]) {
      sqlite.prepare('INSERT INTO user (id,name,email,"createdAt","updatedAt","isBot","ownerUserId") VALUES (?,?,?,?,?,?,?)')
        .run(id, id, `${id}@example.invalid`, "now", "now", id === "bot" ? 1 : 0, id === "bot" ? "owner" : null);
    }
    sqlite.exec(`
      INSERT INTO community_server (id,name,owner_id,created_at) VALUES ('server','server','owner','now');
      INSERT INTO community_server_member (id,server_id,user_id,role,joined_at) VALUES
        ('owner-member','server','owner','owner','now'),('reader-member','server','reader','member','now'),('bot-member','server','bot','member','now');
      INSERT INTO community_category (id,server_id,name,private,creator_id) VALUES ('private','server','private',1,'owner');
      INSERT INTO community_channel (id,server_id,type,category_id,creator_id,created_at) VALUES
        ('public','server','text',NULL,'owner','now'),('private-channel','server','text','private','owner','now'),
        ('thread','server','thread',NULL,'owner','now'),('dm',NULL,'dm',NULL,NULL,'now');
      UPDATE community_channel SET parent_channel_id='private-channel' WHERE id='thread';
      INSERT INTO community_channel_member (id,channel_id,user_id,relation,added_at) VALUES
        ('private-reader','private-channel','reader','access','now'),('dm-reader','dm','reader','access','now'),('dm-bot','dm','bot','access','now');
      INSERT INTO community_message (id,channel_id,author_id,content,type,seq,created_at) VALUES
        ('public-message','public','bot','Page','default',1,'now'),('private-message','thread','bot','Page','default',1,'now'),
        ('dm-message','dm','bot','Page','default',1,'now');
    `);
  });
  afterEach(() => store?.sqlite.close());

  const binding = (id = "page", messageId = "public-message", botId = "bot") => ({
    id, artifactId: `art_${id}`, messageId, botId, createdAt: "now",
  });

  it("binds only an active bot's own message and enforces unique artifact/message ownership", async () => {
    await pageBindingStatement(store.db, binding());
    await expect(getReadablePage(store.db, "page", "reader")).resolves.toMatchObject({ messageId: "public-message", channelId: "public", botId: "bot" });
    await expect(getReadablePageForArtifact(store.db, "art_page", "outsider")).resolves.toBeNull();
    expect(() => pageBindingStatement(store.db, binding("duplicate")).run()).toThrow(/UNIQUE/);
    await pageBindingStatement(store.db, binding("wrong-author", "private-message", "owner"));
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_page").get()).toEqual({ n: 1 });
    store.sqlite.prepare('UPDATE user SET "deletedAt"=? WHERE id=?').run("now", "bot");
    await pageBindingStatement(store.db, binding("deleted-bot", "private-message"));
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_page").get()).toEqual({ n: 1 });
  });

  it("inherits private parent access and revokes after membership, account or source deletion", async () => {
    await pageBindingStatement(store.db, binding("private-page", "private-message"));
    await expect(getReadablePage(store.db, "private-page", "reader")).resolves.not.toBeNull();
    store.sqlite.prepare("DELETE FROM community_channel_member WHERE id=?").run("private-reader");
    await expect(getReadablePage(store.db, "private-page", "reader")).resolves.toBeNull();
    await expect(getReadablePage(store.db, "private-page", "owner")).resolves.not.toBeNull();
    store.sqlite.prepare('UPDATE user SET "deletedAt"=? WHERE id=?').run("now", "owner");
    await expect(getReadablePage(store.db, "private-page", "owner")).resolves.toBeNull();
    store.sqlite.prepare("DELETE FROM community_message WHERE id=?").run("private-message");
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_page").get()).toEqual({ n: 0 });
  });

  it("denies blocked DMs and uses resource-key searches with unrelated data present", async () => {
    await pageBindingStatement(store.db, binding("dm-page", "dm-message"));
    await expect(getReadablePage(store.db, "dm-page", "reader")).resolves.not.toBeNull();
    store.sqlite.prepare("INSERT INTO community_friendship (id,requester_id,addressee_id,status,created_at,updated_at) VALUES ('block','reader','bot','blocked','now','now')").run();
    await expect(getReadablePage(store.db, "dm-page", "reader")).resolves.toBeNull();
    store.sqlite.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO community_message(id,channel_id,author_id,content,type,seq,created_at) SELECT 'noise-'||x,'public','bot','','default',x+1,'now' FROM n;");
    store.sqlite.exec("INSERT INTO community_page(id,artifact_id,message_id,bot_id,created_at) SELECT 'noise-page-'||seq,'noise-art-'||seq,id,'bot','now' FROM community_message WHERE channel_id='public' AND seq>1;");
    reads = [];
    await getReadablePage(store.db, "dm-page", "reader");
    await getReadablePageForArtifact(store.db, "art_dm-page", "reader");
    expect(reads).toHaveLength(2);
    for (const query of reads) {
      assertNoBusinessTableScans(store.sqlite, query);
      expect(queryPlan(store.sqlite, query).some(row => /SEARCH community_page USING INDEX/.test(row.detail))).toBe(true);
    }
  });

  it("consumes a short-lived viewer ticket once and rechecks permissions at consumption", async () => {
    await pageBindingStatement(store.db, binding());
    const now = "2026-11-27T00:00:00.000Z";
    const ticket = { hash: "hash", userId: "reader", pageId: "page", origin: "https://pages.example.invalid", now, expiresAt: "2026-11-27T00:01:00.000Z" };
    await createPageViewerTicket(store.db, ticket);
    const consumed = await Promise.all([
      consumePageViewerTicket(store.db, ticket.hash, ticket.origin, now),
      consumePageViewerTicket(store.db, ticket.hash, ticket.origin, now),
    ]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect(consumed.find(Boolean)).toMatchObject({ userId: "reader", page: { id: "page" } });
    await createPageViewerTicket(store.db, { ...ticket, hash: "expired" });
    await expect(consumePageViewerTicket(store.db, "expired", ticket.origin, ticket.expiresAt)).resolves.toBeNull();
    await createPageViewerTicket(store.db, { ...ticket, hash: "wrong-origin" });
    await expect(consumePageViewerTicket(store.db, "wrong-origin", "https://evil.invalid", now)).resolves.toBeNull();
    await createPageViewerTicket(store.db, { ...ticket, hash: "removed-reader" });
    store.sqlite.prepare("DELETE FROM community_server_member WHERE user_id=?").run("reader");
    await expect(consumePageViewerTicket(store.db, "removed-reader", ticket.origin, now)).resolves.toBeNull();
  });

  it("reads owned Page archives only for their active uploader", async () => {
    const uploaded = await createAttachment(store.db, {
      uploaderId: "bot",
      r2Key: "attachments/page.zip",
      filename: "page.zip",
      contentType: "application/zip",
      size: 128,
    });
    reads = [];
    await expect(getOwnedAttachmentById(store.db, uploaded.id, "bot")).resolves.toMatchObject({ id: uploaded.id, uploaderId: "bot" });
    await expect(getOwnedAttachmentById(store.db, uploaded.id, "reader")).resolves.toBeNull();
    for (const query of reads) assertNoBusinessTableScans(store.sqlite, query);
    store.sqlite.prepare('UPDATE user SET "deletedAt"=? WHERE id=?').run("now", "bot");
    await expect(getOwnedAttachmentById(store.db, uploaded.id, "bot")).resolves.toBeNull();
  });
});
