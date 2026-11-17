import { env } from "cloudflare:workers"
import { expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

it("keeps single-owner plan changes independent of other-plan live resources", async () => {
  const raw = (env as unknown as { DB: D1Database }).DB
  const db = createDb(raw)
  const prefix = `owner_plan_${crypto.randomUUID().replaceAll("-", "")}`
  const owner = `${prefix}_owner`, bot = `${prefix}_bot`, machine = `${prefix}_machine`
  const targetPlan = `${prefix}_target_plan`, foreignPlan = `${prefix}_foreign_plan`
  await raw.batch([
    raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'9999')").bind(owner, owner, `${owner}@test.example`),
    raw.prepare("INSERT INTO product_plan(id,display_name,is_active) VALUES(?,?,1),(?,?,1)").bind(targetPlan, targetPlan, foreignPlan, foreignPlan),
    raw.prepare("INSERT INTO product_plan_entitlement(plan_id,entitlement_key,value_json) VALUES(?,'bots.max','0'),(?,'machines.max','0'),(?,'bots.max','10'),(?,'machines.max','10')").bind(targetPlan, targetPlan, foreignPlan, foreignPlan),
    raw.prepare("INSERT INTO community_machine(id,user_id,status,created_at,updated_at) VALUES(?,?,'online','2026-01-01','2026-01-01')").bind(machine, owner),
    raw.prepare("INSERT INTO user(id,name,email,discriminator,isBot,ownerUserId) VALUES(?,?,?,'0001',1,?)").bind(bot, bot, `${bot}@test.example`, owner),
    raw.prepare("INSERT INTO community_bot_binding(user_id,machine_id,runtime,is_active,created_at) VALUES(?,?,'codex-cli',1,'2026-01-01')").bind(bot, machine),
  ])
  let captured: { sql: string; params: unknown[] }[] = []
  const executeBatch = db.batch.bind(db)
  db.batch = (async statements => { captured = statements.map(statement => statement.toSQL()); return executeBatch(statements) }) as typeof db.batch
  try {
    expect(await queries.productPlan.assignUserPlan(db, owner, targetPlan)).toEqual({ plan: { id: targetPlan, displayName: targetPlan }, limit: 0, deactivatedBotIds: [bot], disconnectedMachines: [{ machineId: machine, userId: owner, doName: null }] })
    expect(captured).toHaveLength(6)
    const reads: number[][] = []
    let previous = 0
    for (const count of [10, 1000, 10000]) {
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1<=?) INSERT INTO user(id,name,email,discriminator) SELECT ?||i,?||i,?||i||'@test.example','0001' FROM n").bind(previous + 1, count, `${prefix}_foreign_`, `${prefix}_foreign_`, `${prefix}_foreign_`).run()
      await raw.prepare("INSERT INTO user_product_plan(user_id,plan_id) SELECT id,? FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM user_product_plan WHERE user_id=user.id)").bind(foreignPlan, `${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO community_machine(id,user_id,status,created_at,updated_at) SELECT id||'_machine',id,'online','2026-01-01','2026-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM community_machine WHERE community_machine.id=user.id||'_machine')").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO user(id,name,email,discriminator,isBot,ownerUserId) SELECT 'active_'||id,'active_'||id,'active_'||id||'@test.example','0001',1,id FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM user AS bot WHERE bot.id='active_'||user.id)").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO community_bot_binding(user_id,machine_id,runtime,is_active,created_at) SELECT id,ownerUserId||'_machine','codex-cli',1,'2026-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM community_bot_binding WHERE user_id=user.id)").bind(`active_${prefix}_foreign_`, `active_${prefix}_foreign_\uffff`).run()
      await raw.batch([
        raw.prepare("UPDATE user_product_plan SET plan_id='free' WHERE user_id=?").bind(owner),
        raw.prepare("UPDATE community_bot_binding SET is_active=1 WHERE user_id=?").bind(bot),
        raw.prepare("UPDATE community_machine SET status='online' WHERE id=?").bind(machine),
      ])
      const results = await raw.batch(captured.map(query => raw.prepare(query.sql).bind(...query.params)))
      expect(results[0]!.results).toEqual([{ user_id: owner }])
      expect(results[1]!.results).toEqual([{ user_id: bot }])
      expect(results[2]!.results).toEqual([{ id: machine, user_id: owner, do_name: null }])
      expect((await raw.prepare("SELECT is_active FROM community_bot_binding WHERE user_id=?").bind(bot).first<{ is_active: number }>())!.is_active).toBe(0)
      expect((await raw.prepare("SELECT status FROM community_machine WHERE id=?").bind(machine).first<{ status: string }>())!.status).toBe("offline")
      reads.push(results.map(result => result.meta.rows_read)); previous = count
    }
    console.info("single-owner-plan-scope", JSON.stringify({ otherPlanLiveResources: [10, 1000, 10000], reads }))
    expect(reads[1]).toEqual(reads[0]); expect(reads[2]).toEqual(reads[0])
  } finally {
    await raw.prepare("DELETE FROM user WHERE id=?").bind(bot).run()
    await raw.prepare("DELETE FROM community_machine WHERE id=?").bind(machine).run()
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`active_${prefix}_foreign_`, `active_${prefix}_foreign_\uffff`).run()
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`${prefix}_`, `${prefix}_\uffff`).run()
    await raw.prepare("DELETE FROM product_plan WHERE id IN (?,?)").bind(targetPlan, foreignPlan).run()
  }
})
