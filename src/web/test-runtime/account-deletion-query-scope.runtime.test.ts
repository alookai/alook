import { env } from "cloudflare:workers"
import { expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

it("bounds account snapshots and deletion as unrelated live accounts and read states grow", async () => {
  const raw = (env as unknown as { DB: D1Database }).DB
  const prefix = `account_scope_${crypto.randomUUID().replaceAll("-", "")}`
  const owner = `${prefix}_owner`, reader = `${prefix}_reader`, channel = `${prefix}_dm`
  const prior = `${prefix}_prior`, authored = `${prefix}_authored`
  const snapshotSql: { sql: string; params: unknown[] }[] = []
  const db = createDb({ prepare(sql: string) {
    const statement = raw.prepare(sql)
    return { bind(...params: unknown[]) { snapshotSql.push({ sql, params: [...params] }); return statement.bind(...params) } }
  } } as unknown as D1Database)
  const mutationDb = createDb(raw)
  let mutations: { sql: string; params: unknown[] }[] = []
  const execute = mutationDb.batch.bind(mutationDb)
  mutationDb.batch = (async statements => { mutations = statements.map(s => s.toSQL()); return execute(statements) }) as typeof mutationDb.batch
  await raw.batch([
    raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'0001')").bind(reader, reader, `${reader}@test.example`),
    raw.prepare("INSERT INTO community_channel(id,type,created_at) VALUES(?,'dm','2026-01-01')").bind(channel),
    raw.prepare("INSERT INTO community_message(id,channel_id,author_id,seq,created_at) VALUES(?,?,?,1,'2026-01-01')").bind(prior, channel, reader),
  ])
  const seed = async () => {
    await raw.batch([
      raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'9999')").bind(owner, owner, `${owner}@test.example`),
      raw.prepare("INSERT INTO community_message(id,channel_id,author_id,seq,created_at) VALUES(?,?,?,2,'2026-01-02')").bind(authored, channel, owner),
      raw.prepare("INSERT INTO community_read_state(id,user_id,channel_id,last_read_message_id,last_read_seq,last_read_at) VALUES(?,?,?,?,2,'2026-01-02') ON CONFLICT(user_id,channel_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id,last_read_seq=excluded.last_read_seq").bind(`${prefix}_read`, reader, channel, authored),
    ])
  }
  try {
    await seed()
    const snapshot = await queries.accountDeletion.getAccountDeletionSnapshot(db, owner)
    expect(snapshot?.readStateUserIds).toEqual([reader])
    expect(snapshot?.identities.map(row => row.id)).toEqual([owner])
    expect((await queries.accountDeletion.deleteAccountRows(mutationDb, snapshot!)).deleted).toBe(true)
    expect(snapshotSql).toHaveLength(9)
    const reads: number[][] = []
    let previous = 0
    for (const count of [10, 1000, 10000]) {
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1<=?) INSERT INTO user(id,name,email,discriminator) SELECT ?||i,?||i,?||i||'@test.example','0001' FROM n").bind(previous+1,count,`${prefix}_foreign_`,`${prefix}_foreign_`,`${prefix}_foreign_`).run()
      await raw.prepare("INSERT INTO community_channel(id,type,created_at) SELECT id||'_dm','dm','2026-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM community_channel WHERE id=user.id||'_dm')").bind(`${prefix}_foreign_`,`${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO community_read_state(id,user_id,channel_id,last_read_seq,last_read_at) SELECT id||'_read',id,id||'_dm',0,'2026-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM community_read_state WHERE user_id=user.id)").bind(`${prefix}_foreign_`,`${prefix}_foreign_\uffff`).run()
      await seed()
      const snapshots = await raw.batch(snapshotSql.map(q => raw.prepare(q.sql).bind(...q.params)))
      const deleted = await raw.batch(mutations.map(q => raw.prepare(q.sql).bind(...q.params)))
      expect(deleted.at(-1)!.results).toEqual([{ id: owner }])
      expect(await raw.prepare("SELECT last_read_message_id AS id,last_read_seq AS seq FROM community_read_state WHERE user_id=? AND channel_id=?").bind(reader,channel).first()).toEqual({ id:prior,seq:1 })
      expect(await raw.prepare("SELECT id FROM user WHERE id=?").bind(reader).first()).toEqual({id:reader})
      reads.push([...snapshots, ...deleted].map(r => r.meta.rows_read)); previous = count
    }
    console.info("account-deletion-scope", JSON.stringify({unrelatedAccountsAndReadStates:[10,1000,10000],reads}))
    expect(reads[1]).toEqual(reads[0]); expect(reads[2]).toEqual(reads[0])
  } finally {
    await raw.prepare("DELETE FROM community_channel WHERE id>=? AND id<?").bind(`${prefix}_`,`${prefix}_\uffff`).run()
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`${prefix}_`,`${prefix}_\uffff`).run()
  }
})
