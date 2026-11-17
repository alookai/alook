import { env } from "cloudflare:workers"
import { expect, it } from "vitest"
import { createDb, queries } from "@alook/shared"

it.each([true, false])("keeps exact-tag search bounded while preserving case sensitivity (matching case: %s)", async matchingCase => {
  const raw = (env as unknown as { DB: D1Database }).DB
  const prefix = `tag_scope_${crypto.randomUUID().replaceAll("-", "")}`
  const name = `Z_${prefix}`
  const target = `${prefix}_target`
  let captured: { sql: string; params: unknown[] } | undefined
  const db = createDb({ prepare(sql: string) {
    const statement = raw.prepare(sql)
    return { bind(...params: unknown[]) { captured = { sql, params: [...params] }; return statement.bind(...params) } }
  } } as unknown as D1Database)
  await raw.prepare("INSERT INTO user(id,name,email,discriminator) VALUES(?,?,?,'9999')").bind(target, name, `${target}@test.example`).run()
  try {
    const rows = await queries.user.searchUsersByName(db, matchingCase ? name : name.toLowerCase(), { discriminator: "9999" })
    expect(rows.map(row => row.id)).toEqual(matchingCase ? [target] : [])
    expect(captured).toBeDefined()
    const reads: number[] = []
    let previous = 0
    for (const count of [10, 1000, 10000]) {
      await raw.prepare("WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i+1 FROM n WHERE i+1 <= ?) INSERT INTO user(id,name,email,discriminator) SELECT ?||i,CASE WHEN i%2=1 THEN ? ELSE ?||i END,?||i||'@test.example',printf('%04d',i%9999) FROM n")
        .bind(previous + 1, count, `${prefix}_foreign_`, name, `A_${prefix}_`, `${prefix}_foreign_`).run()
      const result = await raw.prepare(captured!.sql).bind(...captured!.params).all<{ id: string }>()
      expect(result.results.map(row => row.id)).toEqual(matchingCase ? [target] : [])
      reads.push(result.meta.rows_read)
      previous = count
    }
    console.info("tagged-user-query-scope", JSON.stringify({ matchingCase, unrelatedUsers: [10, 1000, 10000], reads }))
    expect(reads[1]).toBe(reads[0])
    expect(reads[2]).toBe(reads[0])
  } finally {
    await raw.prepare("DELETE FROM user WHERE id>=? AND id<?").bind(`${prefix}_foreign_`, `${prefix}_foreign_\uffff`).run()
    await raw.prepare("DELETE FROM user WHERE id=?").bind(target).run()
  }
})
