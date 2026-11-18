import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createCommunitySqliteDb } from "@/test/community-sqlite-db"

const state = vi.hoisted(() => ({ db: null as unknown, broadcast: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DB: {} } }) }))
vi.mock("@/lib/db", () => ({ getPrimaryDb: () => state.db }))
vi.mock("@/lib/middleware/auth", () => ({
  humanAuthPolicy: { resolve: async () => ({ context: { env: { DB: {} }, userId: "reader", email: "reader@example.test" } }) },
}))
vi.mock("@/lib/community/fanout", () => ({ broadcastToUserSafe: state.broadcast }))

import { PUT } from "./route"

beforeEach(() => state.broadcast.mockReset().mockResolvedValue(undefined))

it("commits the exact read target and only that viewer's bounded mention clear", async () => {
  const { db, sqlite, record } = createCommunitySqliteDb()
  try {
    state.db = db
    sqlite.exec(`
      INSERT INTO user (id,name,email,discriminator,"avatarVersion","isBot")
        VALUES ('reader','Reader','reader@example.test','0001',0,0),('author','Author','author@example.test','0002',0,0);
      INSERT INTO community_server (id,name,discriminator,description,owner_id,created_at)
        VALUES ('server','Server','0001','','reader','2026-09-07T06:00:00Z');
      INSERT INTO community_server_member (id,server_id,user_id,role) VALUES ('membership','server','reader','owner');
      INSERT INTO community_channel (id,server_id,name,type,topic,position,archived,message_count,created_at)
        VALUES ('scope','server','Scope','text','',0,0,2,'2026-09-07T06:00:00Z');
      INSERT INTO community_message (id,author_id,channel_id,seq,created_at,content,type) VALUES
        ('target','author','scope',3,'2026-09-07T06:01:00Z','target','default'),
        ('later','author','scope',7,'2026-09-07T06:02:00Z','later','default');
      INSERT INTO community_mention (id,message_id,user_id,kind,read) VALUES
        ('cleared','target','reader','mention',0),('later','later','reader','mention',0),('other','target','author','reply',0);
    `)
    const mark = () => PUT(new NextRequest("http://localhost/api/community/channels/scope/read", {
      method: "PUT",
      headers: { "x-alook-community-contract": String(BUSINESS_SCHEMA_VERSION), "Content-Type": "application/json" },
      body: JSON.stringify({ lastReadMessageId: "target" }),
    }), { params: { id: "scope" } } as never)

    const first = await mark()
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ changed: true, targetSeq: 3, revision: 1 })
    expect(sqlite.prepare("SELECT last_read_message_id, last_read_seq FROM community_read_state WHERE user_id=? AND channel_id=?").get("reader", "scope"))
      .toMatchObject({ last_read_message_id: "target", last_read_seq: 3 })
    expect(sqlite.prepare("SELECT id, read FROM community_mention ORDER BY id").all()).toMatchObject([
      { id: "cleared", read: 1 }, { id: "later", read: 0 }, { id: "other", read: 0 },
    ])
    const repeated = await mark()
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ changed: false, targetSeq: 3, revision: 1 })
    expect(record.batches).toEqual([4, 4])
    expect(state.broadcast).toHaveBeenCalledOnce()
  } finally {
    sqlite.close()
  }
})
