import { compileFunction } from 'node:vm'

export function compileSourceDrizzle(plans, db, operators) {
  const statements = []
  const failures = []
  for (const plan of plans) {
    try {
      const parameters = plan.inputs.map(([name]) => name)
      const compute = compileFunction(`"use strict"; return (${plan.expression}).toSQL()`, parameters)
      for (const variant of plan.variants) {
        const args = plan.inputs.map(([, spec], index) => {
          if (spec.db) return db
          if (spec.operator) return operators[spec.operator]
          if (spec.table) {
            const table = db._.fullSchema[spec.table]
            if (!Object.hasOwn(db._.fullSchema, spec.table)) throw new Error(`Table ${spec.table} is absent from createDb schema`)
            return table
          }
          return variant[index]
        })
        const { sql, params } = compute(...args)
        statements.push({ siteKey: plan.siteKey, sql, params })
      }
    } catch (error) {
      failures.push({ siteKey: plan.siteKey, reason: String(error.message ?? error) })
    }
  }
  return { statements, failures }
}
