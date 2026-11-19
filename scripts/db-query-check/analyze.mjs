import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(new URL('../../src/shared/package.json', import.meta.url))
export const Sqlite = require('better-sqlite3')

export function migratedDatabase(root) {
  const db = new Sqlite(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    const directory = resolve(root, 'src/web/migrations')
    for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      db.exec(readFileSync(resolve(directory, file), 'utf8'))
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function normalizedSql(sql) {
  return sql.replace(/'(?:''|[^'])*'/g, '?').replace(/\b\d+(?:\.\d+)?\b/g, '?').replace(/\s+/g, ' ').trim()
}

export function bindShape(params) {
  return params.map(value => value === null ? 'null' : Buffer.isBuffer(value) || value instanceof Uint8Array ? 'blob' : typeof value)
}

function haltsBeforeRowAccess(bytecode) {
  const main = bytecode.slice(0, bytecode.findIndex((row, index) => index > 0 && row.addr === 0) < 0 ? bytecode.length : bytecode.findIndex((row, index) => index > 0 && row.addr === 0))
  const registers = new Map()
  let address = 0
  for (let steps = 0; steps < main.length * 2; steps++) {
    const row = main[address]
    if (!row || row.addr !== address) return false
    if (row.opcode === 'Halt') return row.p1 === 0
    if (row.opcode === 'Init' || row.opcode === 'Goto') { address = row.p2; continue }
    if (row.opcode === 'Integer' || row.opcode === 'Int64') {
      registers.set(row.p2, BigInt(row.opcode === 'Integer' ? row.p1 : row.p4))
    } else if (row.opcode === 'Null') {
      for (let register = row.p2; register <= Math.max(row.p2, row.p3); register++) registers.set(register, null)
    } else if (row.opcode === 'RowSetRead') {
      if (registers.get(row.p1) !== null) return false
      address = row.p2
      continue
    } else if (['Eq', 'Ne', 'Lt', 'Le', 'Gt', 'Ge'].includes(row.opcode)) {
      const a = registers.get(row.p3)
      const b = registers.get(row.p1)
      if (typeof a !== 'bigint' || typeof b !== 'bigint') return false
      const jump = { Eq: a === b, Ne: a !== b, Lt: a < b, Le: a <= b, Gt: a > b, Ge: a >= b }[row.opcode]
      if (jump) { address = row.p2; continue }
    } else if (!['Transaction', 'Noop', 'Explain', 'OpenRead', 'OpenWrite'].includes(row.opcode)) return false
    address++
  }
  return false
}

function boundedLoop(bytecode, position) {
  const start = bytecode[position]
  const comparisons = start.opcode === 'Rewind' ? ['IdxGE', 'IdxGT'] : ['IdxLE', 'IdxLT']
  let rowid
  for (let index = position + 1; index < bytecode.length; index++) {
    const row = bytecode[index]
    if (row.addr === 0 || row.addr >= start.p2) return undefined
    if (comparisons.includes(row.opcode) && row.p1 === start.p1 && row.p2 === start.p2) return row.addr
    if (row.opcode === 'Rowid' && row.p1 === start.p1) { rowid = row.p2; continue }
    const rowidComparisons = start.opcode === 'Rewind' ? ['Ge', 'Gt'] : ['Le', 'Lt']
    if (rowid !== undefined) return rowidComparisons.includes(row.opcode) && row.p3 === rowid && row.p2 === start.p2 ? row.addr : undefined
    if (row.opcode === 'IsNull' && row.p2 === start.p2) continue
    if (!['Variable', 'Integer', 'Int64', 'Real', 'String8', 'String', 'Null', 'Affinity', 'SCopy', 'Copy', 'Noop'].includes(row.opcode)) return undefined
  }
  return undefined
}

function boundedScalarSeek(bytecode, openOffset, stepOffset) {
  const open = bytecode[openOffset]
  const step = bytecode[stepOffset]
  const exit = bytecode[stepOffset + 1]
  const countdown = bytecode[stepOffset - 1]
  if (exit?.opcode !== 'Return' || exit.addr !== step.addr + 1 || exit.p3 !== 1 ||
      countdown.opcode !== 'DecrJumpZero' || countdown.p2 !== exit.addr ||
      step.p2 <= open.addr || step.p2 >= countdown.addr) return false
  const register = countdown.p1
  const begin = bytecode.slice(0, openOffset).findLastIndex(row => row.opcode === 'BeginSubrtn')
  if (begin < 0 || bytecode[begin].p2 !== exit.p1 || exit.addr - bytecode[begin].addr !== stepOffset + 1 - begin) return false
  const setup = bytecode.slice(begin + 1, openOffset)
  const initializer = setup.findIndex(row => row.opcode === 'Integer' && row.p1 === 1 && row.p2 === register)
  if (initializer < 0 || setup.slice(0, initializer).some(row =>
    !['Noop', 'Null', 'Integer'].includes(row.opcode) && !(row.opcode === 'Once' && row.p2 === exit.addr)
  )) return false
  const guard = setup.slice(initializer + 1)
  if (guard.length !== 0) {
    const [compare, zero, integer, skip] = guard
    if (guard.length !== 4 || compare.opcode !== 'Ne' || compare.p2 !== integer.addr ||
        zero.opcode !== 'ZeroOrNull' || zero.p2 !== register || integer.opcode !== 'MustBeInt' ||
        integer.p1 !== register || integer.p2 !== 0 || skip.opcode !== 'IfNot' ||
        skip.p1 !== register || skip.p2 !== exit.addr) return false
  }
  const keysAndRow = bytecode.slice(openOffset + 1, stepOffset - 1)
  return keysAndRow.every(row => {
    if (['SeekGE', 'SeekLE', 'IdxGE', 'IdxGT', 'IdxLE', 'IdxLT'].includes(row.opcode)) {
      return row.p1 === open.p1 && row.p2 === exit.addr &&
        (register < row.p3 || register >= row.p3 + Number(row.p4))
    }
    if (row.opcode === 'IsNull') return row.p2 === exit.addr
    if (row.opcode === 'Null') return register < row.p2 || register > Math.max(row.p2, row.p3)
    if (row.opcode === 'Affinity') return register < row.p1 || register >= row.p1 + row.p2
    if (row.opcode === 'Column') return row.p3 !== register
    if (['Variable', 'Integer', 'Int64', 'Real', 'String8', 'Rowid', 'IdxRowid', 'SCopy'].includes(row.opcode)) return row.p2 !== register
    return row.opcode === 'Noop' || row.opcode === 'DeferredSeek'
  })
}

const indexCursorOpens = ['OpenRead', 'OpenWrite', 'ReopenIdx']
const cursorReplacements = ['OpenEphemeral', 'OpenAutoindex', 'OpenPseudo', 'OpenDup', 'SorterOpen', 'VOpen', 'Close']

function boundedIndexWork(bytecode, rootpage, params, seek) {
  const limits = []
  const lastOpenOffset = seek ? seek.openOffset : bytecode.length - 1
  for (let start = seek?.openOffset ?? 0; start <= lastOpenOffset; start++) {
    const open = bytecode[start]
    if (!['OpenRead', 'ReopenIdx'].includes(open.opcode) || open.p2 !== rootpage || open.p3 !== 0) continue
    for (let index = start + 1; index < bytecode.length; index++) {
      const step = bytecode[index]
      if (step.addr === 0 || step.p1 === open.p1 &&
          (indexCursorOpens.includes(step.opcode) || cursorReplacements.includes(step.opcode))) break
      if (!['Next', 'Prev'].includes(step.opcode) || step.p1 !== open.p1) continue
      if (seek && (index <= seek.offset || step.p2 !== bytecode[seek.offset].addr + 1)) continue
      const body = bytecode.slice(start + 1, index).filter(row => row.addr >= step.p2)
      const output = body.findIndex(row => row.opcode === 'ResultRow')
      if (output < 0) {
        if (!boundedScalarSeek(bytecode, start, index)) return undefined
        limits.push(1)
        continue
      }
      const safeBeforeOutput = new Set(['Column', 'Rowid', 'IdxRowid', 'DeferredSeek', 'Null', 'Integer', 'Real', 'String8', 'Copy', 'SCopy', 'Affinity', 'RealAffinity', 'Noop', 'IdxGE', 'IdxGT', 'IdxLE', 'IdxLT'])
      if (body.slice(0, output).some(row => !safeBeforeOutput.has(row.opcode))) return undefined
      const limit = body.slice(output + 1).find(row => row.opcode === 'DecrJumpZero' && row.p2 > step.addr)
      if (!limit) return undefined
      const assignment = bytecode.find(row => ['Variable', 'Integer'].includes(row.opcode) && row.p2 === limit.p1)
      const value = assignment?.opcode === 'Variable' ? params[assignment.p1 - 1] : assignment?.p1
      if (!Number.isSafeInteger(value) || value <= 0) return undefined
      limits.push(value)
    }
  }
  return limits.length ? Math.max(...limits) : undefined
}

function literalNullRegister(bytecode, before, register) {
  for (let index = before - 1; index >= 0; index--) {
    const row = bytecode[index]
    // Trace only the local fallthrough initialization of this seek key.
    // An unknown opcode may branch or replace the value.
    if (row.addr + 1 !== bytecode[index + 1].addr) return false
    if (row.opcode === 'Null') {
      if (register >= row.p2 && register <= Math.max(row.p2, row.p3)) return true
    } else if (row.opcode === 'Copy' || row.opcode === 'SCopy') {
      const count = row.opcode === 'Copy' ? row.p3 + 1 : 1
      if (register >= row.p2 && register < row.p2 + count) register += row.p1 - row.p2
    } else if (['Variable', 'Integer', 'Int64', 'Real', 'String8', 'String', 'Blob'].includes(row.opcode)) {
      if (row.p2 === register) return false
    } else if (!['Affinity', 'Noop'].includes(row.opcode)) {
      return false
    }
  }
  return false
}

function literalNullSeeks(db, bytecode, index, constraints, lowCardinality) {
  if (constraints.some(term => term.operator !== '=')) return []
  const columns = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name)
  if (constraints.some((term, offset) => columns[offset]?.name !== term.column)) return []
  const cursors = new Map()
  const seeks = []
  for (const [offset, row] of bytecode.entries()) {
    if (row.addr === 0) cursors.clear()
    if (indexCursorOpens.includes(row.opcode)) {
      if (row.p2 === index.rootpage && row.p3 === 0) cursors.set(row.p1, offset)
      else cursors.delete(row.p1)
    }
    if (cursorReplacements.includes(row.opcode)) cursors.delete(row.p1)
    if (!cursors.has(row.p1) || !['SeekGE', 'SeekLE'].includes(row.opcode) || Number(row.p4) !== constraints.length) continue
    const end = bytecode[offset + 1]
    const exactEquality = end?.addr === row.addr + 1 && end.opcode === (row.opcode === 'SeekGE' ? 'IdxGT' : 'IdxLT') &&
      end.p1 === row.p1 && end.p2 === row.p2 && end.p3 === row.p3 && end.p4 === row.p4 &&
      constraints.every(({ column }, slot) => lowCardinality(column) || literalNullRegister(bytecode, offset, row.p3 + slot))
    if (exactEquality) seeks.push({ offset, openOffset: cursors.get(row.p1) })
  }
  return seeks
}

function unscopedSearches(db, plan, schema, bytecode, params) {
  const quote = value => `"${value.replaceAll('"', '""')}"`
  function userOwned(table, seen = new Set()) {
    if (table === 'user') return true
    if (seen.has(table)) return false
    seen.add(table)
    return db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all().some(fk => userOwned(fk.table, seen))
  }
  const lowCardinality = column => /^(?:is|has)(?:_|[A-Z])/.test(column) || /^(?:status|type|relation|source|private|archived|role|kind|visibility)$/i.test(column)
  const bounded = []
  const reportedNullSeeks = new Set()
  function recordBound(source, maxRows, seek = {}) {
    if (maxRows === undefined) return false
    bounded.push({
      table: source.tbl_name, index: source.name, ...seek, maxRows,
      proof: 'each visit counts against a positive row limit before the index can advance',
    })
    return true
  }
  const risks = plan.flatMap(row => {
    const match = /\bSEARCH .*? USING (?:COVERING )?INDEX (\S+) \(([^()]*)\)/.exec(row.detail)
    if (!match) return []
    const source = schema.find(item => item.type === 'index' && item.name === match[1])
    if (!source) return []
    const constraints = match[2].split(' AND ').map(term => {
      const field = /^([a-zA-Z_][a-zA-Z_0-9]*)([=<>])/.exec(term)
      return field ? { column: field[1], operator: field[2] } : undefined
    })
    if (!constraints.length || constraints.some(term => !term) || !userOwned(source.tbl_name)) return []
    const flagsOnly = constraints.every(term => lowCardinality(term.column))
    const prefix = {
      table: source.tbl_name, index: source.name,
      columns: constraints.map(term => term.column),
    }
    if (flagsOnly) {
      if (recordBound(source, boundedIndexWork(bytecode, source.rootpage, params))) return []
      return [{
        ...prefix, detail: row.detail,
        reason: 'index bounds only low-cardinality fields on user-owned data; business scope is not an index bound',
      }]
    }
    // EXPLAIN and EXPLAIN QUERY PLAN do not expose a shared alias identifier.
    // Report the executable seek itself when multiple plan rows use the same index.
    return literalNullSeeks(db, bytecode, source, constraints, lowCardinality).flatMap(seek => {
      if (reportedNullSeeks.has(seek.offset)) return []
      reportedNullSeeks.add(seek.offset)
      const { addr: address, opcode, p1: cursor } = bytecode[seek.offset]
      const location = { cursor, opcode, address }
      if (recordBound(source, boundedIndexWork(bytecode, source.rootpage, params, seek), location)) return []
      return [{
        ...prefix, ...location,
        detail: `${opcode} on index ${source.name} at bytecode address ${address}, cursor ${cursor}`,
        reason: 'index bounds only low-cardinality or literal NULL keys on user-owned data; business scope is not an index bound',
      }]
    })
  })
  return { risks, bounded }
}

export function analyzeQuery(db, sql, params = [], context = { inTransaction: db.inTransaction, deferForeignKeys: db.pragma('defer_foreign_keys', { simple: true }) === 1 }) {
  const version = db.prepare('SELECT sqlite_version() AS version').get().version
  if (version !== '3.53.2') return { sql: normalizedSql(sql), bindShape: bindShape(params), plan: [], scans: [], unscopedSearches: [], error: `SQLite ${version} needs checker compatibility validation (validated: 3.53.2)` }
  const schema = db.prepare("SELECT type, name, tbl_name, rootpage FROM sqlite_schema WHERE rootpage > 0 AND tbl_name NOT LIKE 'sqlite_%'").all()
  const roots = new Map(schema.map(row => [row.rootpage, row]))
  const result = { sql: normalizedSql(sql), bindShape: bindShape(params), plan: [], scans: [], unscopedSearches: [] }
  try {
    result.plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    const bytecode = db.prepare(`EXPLAIN ${sql}`).all(...params)
    const virtualTables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%'").all()
    for (const { name } of virtualTables) {
      const quoted = `"${name.replaceAll('"', '""')}"`
      const pointers = db.prepare(`EXPLAIN SELECT * FROM ${quoted} LIMIT 1`).all().filter(row => row.opcode === 'VOpen').map(row => row.p4)
      if (bytecode.some(row => row.opcode === 'VOpen' && pointers.includes(row.p4))) throw new Error(`Persisted virtual table ${name} requires explicit index-bound analysis`)
    }
    if (haltsBeforeRowAccess(bytecode)) return { ...result, noAccessProof: 'constant guard halts before business row access' }
    const prefixes = unscopedSearches(db, result.plan, schema, bytecode, params)
    result.unscopedSearches = prefixes.risks
    if (prefixes.bounded.length) result.boundedSearches = prefixes.bounded
    const firstSubprogram = bytecode.findIndex((row, index) => index > 0 && row.addr === 0)
    const subprogramCanIncrement = firstSubprogram >= 0 && bytecode.slice(firstSubprogram).some(row => row.opcode === 'FkCounter' && row.p2 > 0)
    let cursors = new Map()
    let counters = new Map([[0, context.deferForeignKeys === false || context.inTransaction === false], [1, context.inTransaction === false]])
    let skipUntil = -1
    const skipped = []
    for (const [position, row] of bytecode.entries()) {
      if (row.opcode === 'Init') { cursors = new Map(); counters = new Map([[0, row === bytecode[0] && (context.deferForeignKeys === false || context.inTransaction === false)], [1, row === bytecode[0] && context.inTransaction === false]]); skipUntil = -1 }
      if (row.addr < skipUntil) continue
      if (row.opcode === 'FkIfZero' && counters.get(row.p1) && row.p2 > row.addr) {
        skipped.push({ from: row.addr + 1, to: row.p2 - 1, proof: `foreign key counter ${row.p1} is proved zero before this guarded block` })
        skipUntil = row.p2
        continue
      }
      if (row.opcode === 'FkCounter' && row.p2 > 0 && !(row.p1 === 0 && context.insertedParentsSatisfied === true)) counters.set(row.p1, false)
      if (row.opcode === 'Program' && subprogramCanIncrement) { counters.set(0, false); counters.set(1, false) }
      if (['OpenRead', 'OpenWrite', 'ReopenIdx'].includes(row.opcode)) {
        if (row.p3 === 0 && roots.has(row.p2)) cursors.set(row.p1, roots.get(row.p2))
        else cursors.delete(row.p1)
      }
      if (['OpenEphemeral', 'OpenAutoindex', 'VOpen', 'OpenPseudo', 'SorterOpen', 'Close'].includes(row.opcode)) cursors.delete(row.p1)
      if (row.opcode === 'OpenDup' && cursors.has(row.p2)) cursors.set(row.p1, cursors.get(row.p2))
      if (row.opcode === 'Clear' && row.p2 === 0 && roots.has(row.p1)) {
        const source = roots.get(row.p1)
        result.scans.push({ table: source.tbl_name, access: source.type, index: source.type === 'index' ? source.name : null, opcode: row.opcode, address: row.addr })
      }
      if (['Rewind', 'Last', 'Count'].includes(row.opcode) && cursors.has(row.p1)) {
        const source = cursors.get(row.p1)
        const boundary = ['Rewind', 'Last'].includes(row.opcode) ? boundedLoop(bytecode, position) : undefined
        if (boundary !== undefined) {
          result.boundedLoops ??= []
          result.boundedLoops.push({ table: source.tbl_name, index: source.type === 'index' ? source.name : null, start: row.addr, boundary })
          continue
        }
        const scan = { table: source.tbl_name, access: source.type, index: source.type === 'index' ? source.name : null, opcode: row.opcode, address: row.addr }
        if (!result.scans.some(old => old.table === scan.table && old.index === scan.index && old.opcode === scan.opcode)) result.scans.push(scan)
      }
    }
    if (skipped.length) result.skippedForeignKeyBlocks = skipped
  } catch (error) {
    result.error = String(error.message)
  }
  return result
}

export function foreignKeyQueries(db) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  const queries = []
  const quote = value => `"${value.replaceAll('"', '""')}"`
  for (const { name } of tables) {
    const groups = new Map()
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()) {
      const group = groups.get(fk.id) ?? []
      group.push(fk)
      groups.set(fk.id, group)
    }
    for (const [id, group] of groups) {
      group.sort((a, b) => a.seq - b.seq)
      queries.push({ source: `${name}:foreign-key:${id}`, parent: group[0].table, sql: `SELECT 1 FROM ${quote(name)} WHERE ${group.map(fk => `${quote(fk.from)} = ?`).join(' AND ')}`, params: group.map(() => '__query_check_parent__') })
    }
  }
  return queries
}
