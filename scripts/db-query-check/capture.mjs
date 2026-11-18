import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backendRoots, productionFile, sourceFrames } from './inventory.mjs'
import { querySource, queryOrigin } from './source-context.mjs'

function nativeStack() {
  const previous = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_error, frames) => frames.flatMap(frame => {
      const file = frame.getFileName()?.replaceAll('\\', '/')
      return file && backendRoots.some(directory => file.includes(`/${directory}/`)) && productionFile(file) ? [` at (${file}:${frame.getLineNumber()}:${frame.getColumnNumber()})`] : []
    }).join('\n')
    return new Error().stack ?? ''
  } finally { Error.prepareStackTrace = previous }
}

function insertedParentsSatisfied(database, prepare, sql, params) {
  const identifier = '("(?:""|[^""])+"|[a-zA-Z_][a-zA-Z_0-9]*)'
  const match = new RegExp(`^\\s*insert\\s+into\\s+${identifier}\\s*\\(([^)]+)\\)\\s*values\\s*\\(([^()]*)\\)\\s*(?:returning[^;]*)?;?\\s*$`, 'i').exec(sql)
  if (!match || params.some(value => value && typeof value === 'object')) return undefined
  const unquote = value => value.trim().replace(/^"|"$/g, '').replaceAll('""', '"')
  const quote = value => `"${value.replaceAll('"', '""')}"`
  const columns = match[2].split(',').map(unquote)
  const values = match[3].match(/'(?:''|[^'])*'|[^,]+/g)?.map(value => value.trim()) ?? []
  if (values.length !== columns.length) return undefined
  let index = 0
  const data = new Map()
  for (let i = 0; i < columns.length; i++) {
    const token = values[i]
    let value
    if (token === '?') value = params[index++]
    else if (/^null$/i.test(token)) value = null
    else if (/^-?\d+$/.test(token)) value = Number(token)
    else if (/^'(?:''|[^'])*'$/.test(token)) value = token.slice(1, -1).replaceAll("''", "'")
    else return undefined
    data.set(columns[i], value)
  }
  if (index !== params.length) return undefined
  try {
    const definition = prepare.call(database, "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(unquote(match[1]))?.sql ?? ''
    if (/on\s+conflict\s+replace/i.test(definition)) return undefined
    const groups = new Map()
    for (const fk of prepare.call(database, `PRAGMA foreign_key_list(${quote(unquote(match[1]))})`).all()) {
      const group = groups.get(fk.id) ?? []
      group.push(fk)
      groups.set(fk.id, group)
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.seq - b.seq)
      if (group.some(fk => !data.has(fk.from))) return undefined
      const bound = group.map(fk => data.get(fk.from))
      if (bound.some(value => value === null)) continue
      let parentColumns = group.map(fk => fk.to)
      if (parentColumns.some(column => !column)) parentColumns = prepare.call(database, `PRAGMA table_info(${quote(group[0].table)})`).all().filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name)
      if (parentColumns.length !== bound.length) return undefined
      const lookup = `SELECT 1 FROM ${quote(group[0].table)} WHERE ${parentColumns.map(column => `${quote(column)}=?`).join(' AND ')} LIMIT 1`
      if (!prepare.call(database, lookup).get(...bound)) return false
    }
    return true
  } catch { return undefined }
}

export function instrumentDatabase(prototype, collect) {
  const original = prototype.prepare
  const originalExec = prototype.exec
  if (originalExec) prototype.exec = function (sql, ...args) {
    collect({ sql, params: [], stack: nativeStack() })
    return originalExec.call(this, sql, ...args)
  }
  prototype.prepare = function (sql, ...options) {
    const scope = querySource.getStore()
    const compiled = scope?.compiled
    if (compiled) delete scope.compiled
    const source = compiled?.sql === sql ? { ...scope, compiled } : scope
    const origin = source && source.kind !== 'test-fixture' ? '' : nativeStack()
    const database = this
    const context = params => {
      let deferForeignKeys
      try { deferForeignKeys = original.call(database, 'PRAGMA defer_foreign_keys').get().defer_foreign_keys === 1 } catch { deferForeignKeys = undefined }
      return { inTransaction: typeof database.inTransaction === 'boolean' ? database.inTransaction : database.isTransaction, deferForeignKeys, insertedParentsSatisfied: insertedParentsSatisfied(database, original, sql, params) }
    }
    let statement
    try { statement = original.call(this, sql, ...options) } catch (error) {
      collect({ sql, params: [], stack: origin, source })
      throw error
    }
    let bound
    let proxy
    proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        return (...args) => {
          if (key === 'bind') bound = args
          if (['all', 'get', 'run', 'iterate'].includes(key)) {
            const registered = queryOrigin(proxy)
            const executingSource = registered?.kind === 'test-fixture' && registered.proof === 'literal-sql' && registered.literalSql === sql ? registered : source ?? registered ?? querySource.getStore()
            collect({ sql, params: bound ?? args, source: executingSource, context: () => context(bound ?? args), stack: executingSource && executingSource.kind !== 'test-fixture' ? '' : `${origin}\n${nativeStack()}` })
          }
          const result = Reflect.apply(value, target, args)
          return result === target ? proxy : result
        }
      },
    })
    return proxy
  }
  return () => { prototype.prepare = original; if (originalExec) prototype.exec = originalExec }
}

export function createCapture(root) {
  const records = new Map()
  return {
    collect(query) {
      const frames = sourceFrames(root, query.stack)
      if (query.source?.kind === 'test-fixture' && !frames.length) return
      if (query.source) frames.unshift({ file: query.source.file, line: query.source.line, column: 1 })
      if (!frames.length || !/^\s*(?:select|insert|update|delete|replace|with)\b/i.test(query.sql)) return
      const params = query.params.length === 1 && Array.isArray(query.params[0]) ? query.params[0] : query.params
      const serializable = params.map(value => typeof value === 'bigint' ? { bigint: String(value) } : value instanceof Uint8Array ? { blob: Buffer.from(value).toString('base64') } : value)
      const fixtureSqlVerified = query.source?.kind === 'test-fixture' && (query.source.literalSql === query.sql || query.source.preparedSql === query.sql)
      const composedSiteKeys = query.source?.kind !== 'test-fixture' && query.source?.compiled?.sql === query.sql ? query.source.compiled.siteKeys : undefined
      const record = { sql: query.sql, params: serializable, frames, siteKey: query.source?.kind !== 'test-fixture' || fixtureSqlVerified ? query.source?.key : undefined, fixtureSqlVerified, composedSiteKeys, context: typeof query.context === 'function' ? query.context() : query.context }
      const key = JSON.stringify(record)
      records.set(key, record)
    },
    write(directory) {
      writeFileSync(join(directory, `${process.pid}-${randomUUID()}.json`), JSON.stringify({ records: [...records.values()] }), { mode: 0o600 })
    },
  }
}

export function nativeDatabasePrototypes(root) {
  const require = createRequire(join(root, 'src/shared/package.json'))
  return [require('better-sqlite3').prototype, require('node:sqlite').DatabaseSync.prototype]
}
