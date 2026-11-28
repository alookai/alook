import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedDb } from "../helpers/migrated-db";
import { assertNoBusinessTableScans, type BoundQuery, queryPlan } from "../helpers/query-plan";
import { createAttachment, getOwnedAttachmentById } from "../../src/db/queries/community/attachment";
import { getOwnedPage, deleteOwnedPage, listOwnedPages, createPage, getReadableResource, listReadablePageChannels, consumePageViewerTicket, createPageViewerTicket, getReadablePage, getReadablePageForArtifact, pageBindingStatement } from "../../src/db/queries/community/page";

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

  const binding = (id = "page", messageId = "public-message", authorId = "bot") => ({ id, messageId, authorId });
  async function resource(id = "page") {
    const archive = await createAttachment(store.db, { uploaderId: "bot", r2Key: `attachments/${id}.zip`, filename: "page.zip", contentType: "application/zip", size: 128 });
    return createPage(store.db, { id, artifactId: `art_${id}`, archiveAttachmentId: archive.id, botId: "bot", type: "page", title: "Test", createdAt: "now" });
  }

  it("stores a Page independently and links only the specified author's messages", async () => {
    await resource();
    await expect(getReadableResource(store.db, "page", "bot")).resolves.not.toBeNull();
    await expect(getReadableResource(store.db, "page", "reader")).resolves.toBeNull();
    await pageBindingStatement(store.db, binding());
    await expect(getReadablePage(store.db, "page", "reader")).resolves.toMatchObject({ messageId: "public-message", channelId: "public", botId: "bot", sourceBotId: "bot" });
    await expect(getReadablePageForArtifact(store.db, "art_page", "outsider")).resolves.toBeNull();
    expect(() => pageBindingStatement(store.db, binding()).run()).toThrow(/UNIQUE/);
    expect(() => pageBindingStatement(store.db, binding("page", "private-message", "owner")).run()).toThrow(/NOT NULL/);
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_message_page").get()).toEqual({ n: 1 });
  });

  it("forwards one live resource, requires an exact opening source when ambiguous, and retains other associations", async () => {
    await resource();
    await pageBindingStatement(store.db, binding());
    await pageBindingStatement(store.db, binding("page", "private-message"));
    await expect(getReadableResource(store.db, "page", "reader")).resolves.toMatchObject({ artifactId: "art_page" });
    await expect(getReadablePage(store.db, "page", "reader")).resolves.toBeNull();
    await expect(getReadablePage(store.db, "page", "reader", "public-message")).resolves.toMatchObject({ channelId: "public" });
    await expect(getReadablePage(store.db, "page", "reader", "dm-message")).resolves.toBeNull();
    expect(await listReadablePageChannels(store.db, "art_page", "reader")).toHaveLength(2);
    store.sqlite.prepare("DELETE FROM community_message WHERE id=?").run("public-message");
    await expect(getReadableResource(store.db, "page", "reader")).resolves.not.toBeNull();
    await expect(getReadablePage(store.db, "page", "reader", "public-message")).resolves.toBeNull();
    store.sqlite.prepare("DELETE FROM community_message WHERE id=?").run("private-message");
    await expect(getReadableResource(store.db, "page", "reader")).resolves.toBeNull();
    await expect(getReadableResource(store.db, "page", "bot")).resolves.not.toBeNull();
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_page").get()).toEqual({ n: 1 });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_attachment").get()).toEqual({ n: 1 });
  });

  it("rechecks resource access inside the atomic link mutation", async () => {
    await resource(); await pageBindingStatement(store.db, binding());
    store.sqlite.prepare('INSERT INTO user (id,name,email,"createdAt","updatedAt","isBot","ownerUserId") VALUES (?,?,?,?,?,?,?)').run("forwarder", "forwarder", "forwarder@invalid", "now", "now", 1, "owner");
    store.sqlite.prepare("INSERT INTO community_server_member(id,server_id,user_id,role,joined_at) VALUES ('forwarder-member','server','forwarder','member','now')").run();
    await expect(getReadableResource(store.db, "page", "forwarder")).resolves.not.toBeNull();
    const pendingLink = pageBindingStatement(store.db, binding("page", "forwarded-message", "forwarder"));
    store.sqlite.prepare("DELETE FROM community_server_member WHERE id='forwarder-member'").run();
    const write = store.sqlite.transaction(() => {
      store.sqlite.prepare("INSERT INTO community_message(id,channel_id,author_id,content,type,seq,created_at) VALUES ('forwarded-message','dm','forwarder','','default',2,'now')").run();
      pendingLink.run();
    });
    expect(write).toThrow(/NOT NULL/);
    expect(store.sqlite.prepare("SELECT id FROM community_message WHERE id='forwarded-message'").get()).toBeUndefined();
    store.sqlite.prepare("INSERT INTO community_server_member(id,server_id,user_id,role,joined_at) VALUES ('forwarder-member','server','forwarder','member','now')").run();
    write();
    await expect(getReadablePage(store.db, "page", "reader", "forwarded-message")).resolves.toMatchObject({ artifactId: "art_page", sourceBotId: "forwarder", channelId: "dm" });
  });

  it("inherits private parent access and revokes after membership, account or source deletion", async () => {
    await resource("private-page");
    await pageBindingStatement(store.db, binding("private-page", "private-message"));
    await expect(getReadablePage(store.db, "private-page", "reader")).resolves.not.toBeNull();
    store.sqlite.prepare("DELETE FROM community_channel_member WHERE id=?").run("private-reader");
    await expect(getReadablePage(store.db, "private-page", "reader")).resolves.toBeNull();
    await expect(getReadablePage(store.db, "private-page", "owner")).resolves.not.toBeNull();
    store.sqlite.prepare('UPDATE user SET "deletedAt"=? WHERE id=?').run("now", "owner");
    await expect(getReadablePage(store.db, "private-page", "owner")).resolves.toBeNull();
    store.sqlite.prepare("DELETE FROM community_message WHERE id=?").run("private-message");
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_page").get()).toEqual({ n: 1 });
  });

  it("denies blocked DMs and uses resource-key searches with unrelated data present", async () => {
    await resource("dm-page");
    await pageBindingStatement(store.db, binding("dm-page", "dm-message"));
    await expect(getReadablePage(store.db, "dm-page", "reader")).resolves.not.toBeNull();
    store.sqlite.prepare("INSERT INTO community_friendship (id,requester_id,addressee_id,status,created_at,updated_at) VALUES ('block','reader','bot','blocked','now','now')").run();
    await expect(getReadablePage(store.db, "dm-page", "reader")).resolves.toBeNull();
    store.sqlite.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO community_message(id,channel_id,author_id,content,type,seq,created_at) SELECT 'noise-'||x,'public','bot','','default',x+1,'now' FROM n;");
    store.sqlite.exec("INSERT INTO community_attachment(id,uploader_id,r2_key,filename,content_type,size,created_at) SELECT 'noise-archive-'||seq,'bot',id,'page.zip','application/zip',128,'now' FROM community_message WHERE channel_id='public' AND seq>1;");
    store.sqlite.exec("INSERT INTO community_page(id,artifact_id,archive_attachment_id,bot_id,type,title,created_at) SELECT 'noise-page-'||seq,'noise-art-'||seq,'noise-archive-'||seq,'bot','page','Noise','now' FROM community_message WHERE channel_id='public' AND seq>1;");
    reads = [];
    await getReadablePage(store.db, "dm-page", "reader");
    await getReadablePageForArtifact(store.db, "art_dm-page", "reader");
    await getReadableResource(store.db, "dm-page", "reader");
    await listReadablePageChannels(store.db, "art_dm-page", "reader");
    expect(reads).toHaveLength(4);
    for (const query of reads) {
      assertNoBusinessTableScans(store.sqlite, query);
      expect(queryPlan(store.sqlite, query).some(row => /SEARCH community_page USING INDEX/.test(row.detail))).toBe(true);
    }
  });

  it("consumes a short-lived viewer ticket once and rechecks permissions at consumption", async () => {
    await resource();
    await pageBindingStatement(store.db, binding());
    const now = "2026-11-27T00:00:00.000Z";
    const ticket = { hash: "hash", sourceMessageId: "public-message", userId: "reader", pageId: "page", origin: "https://pages.example.invalid", now, expiresAt: "2026-11-27T00:01:00.000Z" };
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

  it("lists only the creator's resources with total, bounded pagination and indexed message counts", async () => {
    for (const id of ["page-a", "page-b", "page-c"]) await resource(id);
    await pageBindingStatement(store.db, binding("page-a")); await pageBindingStatement(store.db, binding("page-a", "private-message"));
    store.sqlite.prepare('INSERT INTO user(id,name,email,"createdAt","updatedAt","isBot") VALUES (?,?,?,?,?,?)').run("other-bot", "Other", "other@invalid", "now", "now", 1);
    store.sqlite.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO community_attachment(id,uploader_id,r2_key,filename,content_type,size,created_at) SELECT 'other-archive-'||x,'other-bot','other-key-'||x,'page.zip','application/zip',128,'now' FROM n;");
    store.sqlite.exec("INSERT INTO community_page(id,artifact_id,archive_attachment_id,bot_id,type,title,created_at) SELECT 'other-page-'||id,'other-art-'||id,id,'other-bot','page','Other','now' FROM community_attachment WHERE uploader_id='other-bot';");
    reads = [];
    const first = await listOwnedPages(store.db, "bot", { limit: 2 });
    expect(first.total).toBe(3); expect(first.pages.map(page => [page.id, page.messageCount])).toEqual([["page-c", 0], ["page-b", 0]]);
    const last = await listOwnedPages(store.db, "bot", { limit: 2, cursor: first.nextCursor });
    expect(last.pages.map(page => [page.id, page.messageCount])).toEqual([["page-a", 2]]); expect(last.nextCursor).toBeUndefined();
    await expect(listOwnedPages(store.db, "reader")).resolves.toMatchObject({ total: 0, pages: [] });
    for (const query of reads) assertNoBusinessTableScans(store.sqlite, query);
    expect(queryPlan(store.sqlite, reads[1]!).some(row => /idx_community_page_bot_id/.test(row.detail))).toBe(true);
  });

  it("deletes only a creator's resource and immediately revokes every linked viewer", async () => {
    await resource(); await pageBindingStatement(store.db, binding()); await pageBindingStatement(store.db, binding("page", "private-message"));
    await expect(getOwnedPage(store.db, "page", "reader")).resolves.toBeNull();
    await expect(deleteOwnedPage(store.db, "page", "reader")).resolves.toBeNull();
    await expect(getOwnedPage(store.db, "page", "bot")).resolves.toMatchObject({ id: "page" });
    reads = []; await expect(deleteOwnedPage(store.db, "page", "bot")).resolves.toEqual({ id: "page" });
    for (const query of reads) assertNoBusinessTableScans(store.sqlite, query);
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_message_page").get()).toEqual({ n: 0 });
    await expect(getReadablePage(store.db, "page", "reader", "public-message")).resolves.toBeNull();
    await expect(getReadableResource(store.db, "art_page", "reader", "artifactId")).resolves.toBeNull();
    await expect(deleteOwnedPage(store.db, "page", "bot")).resolves.toBeNull();
  });

  it("protects a linked archive and preserves account deletion and existing attachment retention", async () => {
    await resource(); await pageBindingStatement(store.db, binding());
    expect(() => store.sqlite.prepare("DELETE FROM community_attachment WHERE uploader_id='bot'").run()).toThrow(/FOREIGN KEY/);
    store.sqlite.prepare("DELETE FROM user WHERE id='bot'").run();
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_page").get()).toEqual({ n: 0 });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_message_page").get()).toEqual({ n: 0 });
    expect(store.sqlite.prepare("SELECT count(*) AS n FROM community_attachment").get()).toEqual({ n: 1 });
    await expect(getOwnedAttachmentById(store.db, (store.sqlite.prepare("SELECT id FROM community_attachment").get() as { id: string }).id, "bot")).resolves.toBeNull();
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
