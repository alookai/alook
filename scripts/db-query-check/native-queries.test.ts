import { expect, it } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as operators from "../../src/shared/node_modules/drizzle-orm"
import { createDb } from "../../src/shared/src/db"
import { compileSourceDrizzle } from "./source-compile.mjs"
import { createMigratedDb } from "../../src/shared/test/helpers/migrated-db"
import { hardDeleteMessage } from "../../src/shared/src/db/queries/community/message"
import { deleteForumPost } from "../../src/shared/src/db/queries/community/forum-post-delete"
import { deleteChannelWithMedia, deleteServerWithMedia } from "../../src/shared/src/db/queries/community/delete-media"

it("loads a real query module as exact raw bytes without constructing a query", async () => {
  const hook = Symbol.for("alook.db-query-check.source")
  const hooks = globalThis as typeof globalThis & { [key: symbol]: ((...args: unknown[]) => unknown) | undefined }
  const previous = hooks[hook]
  let constructions = 0
  hooks[hook] = (...args) => { constructions++; return previous?.(...args) ?? args[0] }
  try {
    const { default: raw } = await import("../../src/shared/src/db/queries/community/bot.ts?raw")
    expect(raw).toBe(readFileSync(resolve(process.env.ALOOK_DB_QUERY_ROOT!, "src/shared/src/db/queries/community/bot.ts"), "utf8"))
    expect(constructions).toBe(0)
  } finally {
    hooks[hook] = previous
  }
})

it.each(["message", "forum", "channel", "server"] as const)("executes the real %s guard for index-scope analysis", async kind => {
  const { sqlite, db } = createMigratedDb()
  try {
    sqlite.exec(`
      INSERT INTO user(id,name,email,discriminator) VALUES('owner','Owner','owner@query-check.example','9999');
      INSERT INTO community_server(id,name,discriminator,owner_id,created_at) VALUES('server','Server','1111','owner','2026-01-01');
      INSERT INTO community_channel(id,server_id,type,created_at,message_count) VALUES('channel','server','${kind === "forum" ? "forum" : "text"}','2026-01-01',1);
      INSERT INTO community_message(id,channel_id,author_id,created_at,seq) VALUES('message','channel','owner','2026-01-01',1);
      INSERT INTO community_read_state(id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES('rs','owner','channel','message',1,'2026-01-01');
    `)
    if (kind === "forum") sqlite.exec(`
      INSERT INTO community_channel(id,server_id,type,parent_channel_id,parent_message_id,created_at) VALUES('child','server','thread','channel','message','2026-01-01');
      INSERT INTO community_message(id,channel_id,author_id,created_at,seq) VALUES('body','child','owner','2026-01-01',1);
      INSERT INTO community_read_state(id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES('child-rs','owner','child','body',1,'2026-01-01');
    `)
    if (kind === "message") await hardDeleteMessage(db, "message")
    else if (kind === "forum") await deleteForumPost(db, { openerId: "message", openerSeq: 1, forumChannelId: "channel", childChannelId: "child" })
    else if (kind === "channel") await deleteChannelWithMedia(db, { channelId: "channel", serverId: "server" })
    else await deleteServerWithMedia(db, { serverId: "server", ownerId: "owner" })
    expect(sqlite.prepare("SELECT id FROM community_message WHERE id=?").get("message")).toBeUndefined()
    expect(sqlite.prepare("SELECT revision FROM community_read_state_revision WHERE user_id=?").get("owner")).toEqual({ revision: 1 })
  } finally {
    sqlite.close()
  }
})


it("compiles statically discovered source expressions without executing their queries", () => {
  const inventory = JSON.parse(readFileSync(process.env.ALOOK_DB_QUERY_INVENTORY!, "utf8"))
  const db = createDb({ prepare() { throw new Error("Source compilation cannot execute SQL") } } as unknown as Parameters<typeof createDb>[0])
  const source = compileSourceDrizzle(inventory.sourceDrizzlePlans, db, operators)
  writeFileSync(resolve(process.env.ALOOK_DB_QUERY_CAPTURE_DIR!, "source-drizzle.data"), JSON.stringify(source), { mode: 0o600 })
})
