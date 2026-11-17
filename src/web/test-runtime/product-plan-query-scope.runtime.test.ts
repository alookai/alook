import { env } from "cloudflare:workers"
import { expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

it.each(["bots", "machines"] as const)("keeps default-plan %s reconciliation independent of unrelated assigned accounts", async resource => {
  const raw = (env as unknown as { DB: D1Database }).DB
  const db = createDb(raw)
  const prefix = `plan_scope_${crypto.randomUUID().replaceAll("-", "")}`
  const owner = `${prefix}_owner`
  const machine = `${prefix}_machine`
  const bot = `${prefix}_bot`
  const foreignPlan = `${prefix}_plan`
  const original = await raw.prepare("SELECT entitlement_key,value_json FROM product_plan_entitlement WHERE plan_id='free' AND entitlement_key IN ('bots.max','machines.max')").all<{ entitlement_key: string; value_json: string }>()
  await raw.prepare("UPDATE product_plan_entitlement SET value_json='10' WHERE plan_id='free' AND entitlement_key IN ('bots.max','machines.max')").run()
  await raw.batch([
    raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'9999')").bind(owner, owner, `${owner}@test.example`),
    raw.prepare("INSERT INTO product_plan(id,display_name,is_default,is_active) VALUES(?,?,0,1)").bind(foreignPlan, foreignPlan),
    raw.prepare("INSERT INTO product_plan_entitlement(plan_id,entitlement_key,value_json) VALUES(?,'bots.max','10'),(?,'machines.max','10')").bind(foreignPlan, foreignPlan),
    raw.prepare("INSERT INTO community_machine(id,user_id,status,created_at,updated_at) VALUES(?,?,'online','2026-01-01','2026-01-01')").bind(machine, owner),
    raw.prepare("INSERT INTO user(id,name,email,discriminator,isBot,ownerUserId) VALUES(?,?,?,'0001',1,?)").bind(bot, bot, `${bot}@test.example`, owner),
    raw.prepare("INSERT INTO community_bot_binding(user_id,machine_id,runtime,is_active,created_at) VALUES(?,?,'codex-cli',1,'2026-01-01')").bind(bot, machine),
  ])
  let captured: { sql: string; params: unknown[] }[] = []
  const executeBatch = db.batch.bind(db)
  db.batch = (async statements => {
    captured = statements.map(statement => statement.toSQL())
    return executeBatch(statements)
  }) as typeof db.batch
  const expected = resource === "bots"
    ? { deactivatedBotIds: [bot] }
    : { deactivatedBotIds: [], disconnectedMachines: [{ machineId: machine, userId: owner, doName: null }] }
  try {
    expect(await queries.productPlan.setPlanEntitlement(db, "free", `${resource}.max`, 0)).toEqual(expected)
    expect(captured.length).toBe(resource === "bots" ? 2 : 5)
    const reads: number[][] = []
    let previous = 0
    for (const count of [10, 1000, 10000]) {
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1 <= ?) INSERT INTO user(id,name,email,discriminator) SELECT ?||i,?||i,?||i||'@test.example','0001' FROM n").bind(previous + 1, count, `${prefix}_foreign_`, `${prefix}_foreign_`, `${prefix}_foreign_`).run()
      await raw.prepare("INSERT INTO user_product_plan(user_id,plan_id) SELECT id,? FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM user_product_plan WHERE user_id=user.id)").bind(foreignPlan, `${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO community_machine(id,user_id,status,created_at,updated_at) SELECT id||'_machine',id,'offline','2026-01-01','2026-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM community_machine WHERE community_machine.id=user.id||'_machine')").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO user(id,name,email,discriminator,isBot,ownerUserId) SELECT 'inactive_'||id,'inactive_'||id, 'inactive_'||id||'@test.example','0001',1,id FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM user AS bot WHERE bot.id='inactive_'||user.id)").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      await raw.prepare("INSERT INTO community_bot_binding(user_id,machine_id,runtime,is_active,created_at) SELECT id,ownerUserId||'_machine','codex-cli',0,'2026-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM community_bot_binding WHERE user_id=user.id)").bind(`inactive_${prefix}_foreign_`, `inactive_${prefix}_foreign_\uffff`).run()
      await raw.batch([
        raw.prepare("UPDATE product_plan_entitlement SET value_json='10' WHERE plan_id='free' AND entitlement_key IN ('bots.max','machines.max')"),
        raw.prepare("UPDATE community_bot_binding SET is_active=1 WHERE user_id=?").bind(bot),
        raw.prepare("UPDATE community_machine SET status='online' WHERE id=?").bind(machine),
      ])
      const results = await raw.batch(captured.map(query => raw.prepare(query.sql).bind(...query.params)))
      expect(results[1]!.results).toEqual(resource === "bots" ? [{ user_id: bot }] : [{ id: machine, user_id: owner, do_name: null }])
      expect((await raw.prepare("SELECT is_active FROM community_bot_binding WHERE user_id=?").bind(bot).first<{ is_active: number }>())!.is_active).toBe(resource === "bots" ? 0 : 1)
      expect((await raw.prepare("SELECT status FROM community_machine WHERE id=?").bind(machine).first<{ status: string }>())!.status).toBe(resource === "machines" ? "offline" : "online")
      reads.push(results.map(result => result.meta.rows_read))
      previous = count
    }
    console.info("product-plan-query-scope-reads", JSON.stringify({ resource, unrelatedHumans: [10, 1000, 10000], reads }))
    expect(reads[1]).toEqual(reads[0])
    expect(reads[2]).toEqual(reads[0])
  } finally {
    await raw.prepare("DELETE FROM user WHERE id=?").bind(bot).run()
    await raw.prepare("DELETE FROM community_machine WHERE id=?").bind(machine).run()
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`inactive_${prefix}_foreign_`, `inactive_${prefix}_foreign_\uffff`).run()
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
    await raw.prepare("DELETE FROM user WHERE id=?").bind(owner).run()
    await raw.prepare("DELETE FROM product_plan WHERE id=?").bind(foreignPlan).run()
    await raw.batch(original.results.map(row => raw.prepare("UPDATE product_plan_entitlement SET value_json=? WHERE plan_id='free' AND entitlement_key=?").bind(row.value_json, row.entitlement_key)))
  }
})
