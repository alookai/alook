import { env } from "cloudflare:workers"
import { expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

it.each(["unbilled", "deleted-billed"] as const)("bounds billing cursor pages as unrelated %s accounts grow", async kind => {
  const raw = (env as unknown as { DB: D1Database }).DB
  const prefix = `billing_page_${crypto.randomUUID().replaceAll("-", "")}`
  let captured: { sql: string; params: unknown[] } | undefined
  const db = createDb({ prepare(sql: string) {
    const statement = raw.prepare(sql)
    return { bind(...params: unknown[]) { captured = { sql, params: [...params] }; return statement.bind(...params) } }
  } } as unknown as D1Database)
  await raw.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<25) INSERT INTO user(id,name,email,discriminator) SELECT ?||printf('%02d',i),?||i,?||i||'@test.example','0001' FROM n")
    .bind(`${prefix}_live_`, `${prefix}_live_`, `${prefix}_live_`).run()
  await raw.prepare("INSERT INTO user_billing(user_id,customer_id,updated_at) SELECT id,'customer_'||id,'2026-01-01' FROM user WHERE id>=? AND id<?")
    .bind(`${prefix}_live_`, `${prefix}_live_\uffff`).run()
  try {
    const initial = await queries.billing.listBillingRecoveryPage(db)
    expect(initial).toHaveLength(25)
    expect(initial.every(row => row.deletedAt === null)).toBe(true)
    const query = captured!
    const reads: number[] = []
    let previous = 0
    for (const count of [10, 1000, 10000]) {
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1<=?) INSERT INTO user(id,name,email,discriminator,deletedAt) SELECT ?||i,?||i,?||i||'@test.example','0001',? FROM n")
        .bind(previous + 1, count, `${prefix}_foreign_`, `${prefix}_foreign_`, `${prefix}_foreign_`, kind === "deleted-billed" ? "2026-01-01" : null).run()
      if (kind === "deleted-billed") await raw.prepare("INSERT INTO user_billing(user_id,customer_id,updated_at) SELECT id,'customer_'||id,'2000-01-01' FROM user WHERE id>=? AND id<? AND NOT EXISTS(SELECT 1 FROM user_billing WHERE user_id=user.id)")
        .bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
      const result = await raw.prepare(query.sql).bind(...query.params).all<{ user_id: string; deletedAt: string | null }>()
      expect(result.results).toHaveLength(25)
      if (kind === "unbilled") expect(result.results.map(row => row.user_id)).toEqual(initial.map(row => row.userId))
      else expect(result.results.filter(row => row.deletedAt !== null)).toHaveLength(Math.min(count, 25))
      const page = await queries.billing.listBillingRecoveryPage(db)
      const last = page.at(-1)!
      const next = await queries.billing.listBillingRecoveryPage(db, { updatedAt: last.updatedAt, userId: last.userId })
      expect(next.length).toBeLessThanOrEqual(25)
      expect(next.some(row => page.some(prior => prior.userId === row.userId))).toBe(false)
      reads.push(result.meta.rows_read)
      previous = count
    }
    console.info("billing-recovery-cursor-scope", JSON.stringify({ kind, unrelatedAccounts: [10, 1000, 10000], reads }))
    expect(reads[1]).toBe(reads[0])
    expect(reads[2]).toBe(reads[0])
  } finally {
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`${prefix}_`, `${prefix}_\uffff`).run()
  }
})
