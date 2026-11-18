import { compileFunction } from 'node:vm'

export function compileSourceDrizzle(plans, db, operators) {
  const statements = []
  const failures = []
  for (const plan of plans) {
    try {
      const declarations = plan.inputs.flatMap(([name, spec]) => spec.initializer ? [`const ${name} = (${spec.initializer})`] : [])
      const parameters = plan.inputs.filter(([, spec]) => !spec.initializer).map(([name]) => name)
      const compute = compileFunction(`"use strict"; ${declarations.join(';\n')}; return (${plan.expression}).toSQL()`, parameters)
      for (const variant of plan.variants) {
        const args = plan.inputs.flatMap(([, spec], index) => {
          if (spec.initializer) return []
          if (spec.db) return [db]
          if (spec.operator) return [operators[spec.operator]]
          if (spec.table) {
            const table = db._.fullSchema[spec.table]
            if (!Object.hasOwn(db._.fullSchema, spec.table)) throw new Error(`Table ${spec.table} is absent from createDb schema`)
            return [table]
          }
          return [variant[index]]
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
