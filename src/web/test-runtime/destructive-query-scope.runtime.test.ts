import { env } from "cloudflare:workers"
import { expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

it.each(["message", "forum", "channel", "server"] as const)("keeps %s deletion work independent of unrelated human accounts", async kind => {
  const raw = (env as unknown as { DB: D1Database }).DB
  const db = createDb(raw)
  const prefix = `scope_${crypto.randomUUID().replaceAll("-", "")}`
  const owner = `${prefix}_owner`
  const server = `${prefix}_server`
  const channel = `${prefix}_channel`
  const message = `${prefix}_message`
  const child = `${prefix}_child`
  const foreignOwner = `${prefix}_retained_owner`
  const foreignServer = `${prefix}_retained_server`
  const foreignChannel = `${prefix}_retained_channel`
  const foreignMessage = `${prefix}_retained_message`
  await raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'9999')").bind(owner, owner, `${owner}@test.example`).run()
  await raw.batch([
    raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'9998')").bind(foreignOwner, foreignOwner, `${foreignOwner}@test.example`),
    raw.prepare("INSERT INTO community_server(id,name,discriminator,owner_id,created_at) VALUES(?,?,'1112',?,'2026-01-01')").bind(foreignServer, foreignServer, foreignOwner),
    raw.prepare("INSERT INTO community_channel(id,server_id,type,created_at) VALUES(?,?,'text','2026-01-01')").bind(foreignChannel, foreignServer),
    raw.prepare("INSERT INTO community_message(id,channel_id,author_id,created_at,seq) VALUES(?,?,?,'2026-01-01',1)").bind(foreignMessage, foreignChannel, foreignOwner),
  ])
  const seedScope = async () => {
    await raw.batch([
      raw.prepare("INSERT OR IGNORE INTO community_server(id,name,discriminator,owner_id,created_at) VALUES(?,?,'1111',?,'2026-01-01')").bind(server, server, owner),
      raw.prepare("INSERT OR IGNORE INTO community_channel(id,server_id,type,created_at,message_count) VALUES(?,?,?,'2026-01-01',1)").bind(channel, server, kind === "forum" ? "forum" : "text"),
      raw.prepare("INSERT INTO community_message(id,channel_id,author_id,created_at,seq) VALUES(?,?,?,'2026-01-01',1)").bind(message, channel, owner),
      raw.prepare("INSERT INTO community_read_state(id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES(?,?,?,?,1,'2026-01-01') ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,last_read_seq=excluded.last_read_seq").bind(`${prefix}_read`, owner, channel, message),
    ])
    if (kind === "forum") {
      await raw.batch([
        raw.prepare("INSERT INTO community_channel(id,server_id,type,parent_channel_id,parent_message_id,created_at) VALUES(?,?,'thread',?,?,'2026-01-01')").bind(child, server, channel, message),
        raw.prepare("INSERT INTO community_message(id,channel_id,author_id,created_at,seq) VALUES(?,?,?,'2026-01-01',1)").bind(`${prefix}_body`, child, owner),
        raw.prepare("INSERT INTO community_read_state(id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES(?,?,?,?,1,'2026-01-01')").bind(`${prefix}_child_read`, owner, child, `${prefix}_body`),
      ])
    }
  }
  let captured: { sql: string; params: unknown[] } | undefined
  const targetTable = kind === "server" ? "community_server" : kind === "channel" ? "community_channel" : "community_message"
  const executeBatch = db.batch.bind(db)
  db.batch = (async statements => {
    captured = statements.map(statement => statement.toSQL()).find(query => query.sql.startsWith(`delete from "${targetTable}" `))
    return executeBatch(statements)
  }) as typeof db.batch
  try {
    await seedScope()
    if (kind === "message") await queries.communityMessage.hardDeleteMessage(db, message)
    else if (kind === "forum") await queries.communityForumPostDelete.deleteForumPost(db, { openerId: message, openerSeq: 1, forumChannelId: channel, childChannelId: child })
    else if (kind === "channel") await queries.communityDeleteMedia.deleteChannelWithMedia(db, { channelId: channel, serverId: server })
    else await queries.communityDeleteMedia.deleteServerWithMedia(db, { serverId: server, ownerId: owner })
    expect(captured).toBeDefined()
    const reads: number[] = []
    let previous = 0
    for (const count of [10, 1000, 10000]) {
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1 <= ?) INSERT INTO user(id,name,email,discriminator) SELECT ?||i,?||i,?||i||'@test.example','0001' FROM n").bind(previous + 1, count, `${prefix}_foreign_`, `${prefix}_foreign_`, `${prefix}_foreign_`).run()
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1 <= ?) INSERT INTO community_bot_approval_request(id,bot_id,kind,server_id,requested_by_user_id,dm_message_id,status,created_at) SELECT ?||i,?,'join_server',?,?,?,'approved','2026-01-01' FROM n").bind(previous + 1, count, `${prefix}_approval_`, foreignOwner, foreignServer, foreignOwner, foreignMessage).run()
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1 <= ?) INSERT INTO product_analytics_event(id,event_name,actor_user_id,server_id,dedupe_key,client_id,session_id,created_at) SELECT ?||i,'test',?,?,?||i,'test','test','2026-01-01' FROM n").bind(previous + 1, count, `${prefix}_analytics_`, foreignOwner, foreignServer, `${prefix}_dedupe_`).run()
      await seedScope()
      const result = await raw.prepare(captured!.sql).bind(...captured!.params).all()
      expect(result.results).toEqual([kind === "server" ? { id: server, icon: null } : { id: kind === "channel" ? channel : message }])
      reads.push(result.meta.rows_read)
      previous = count
    }
    console.info("destructive-query-scope-reads", JSON.stringify({ kind, unrelatedHumans: [10, 1000, 10000], reads }))
    expect(reads[1]).toBe(reads[0])
    expect(reads[2]).toBe(reads[0])
  } finally {
    await raw.prepare("DELETE FROM community_server WHERE id=?").bind(server).run()
    await raw.prepare("DELETE FROM community_server WHERE id=?").bind(foreignServer).run()
    await raw.prepare("DELETE FROM user WHERE id=?").bind(foreignOwner).run()
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
    await raw.prepare("DELETE FROM user WHERE id=?").bind(owner).run()
  }
})
