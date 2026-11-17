import { createRequire } from 'node:module'
import { registerQuerySource } from './source-context.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sqlite, analyzeQuery } from './analyze.mjs'
import { instrumentDatabase, createCapture } from './capture.mjs'
import { sourceFrames, inventoryQueries } from './inventory.mjs'
import { buildReport } from './report.mjs'

test('native statement interception preserves binds, fluent raw statements, errors and cleanup', t => {
  const db = new Sqlite(':memory:')
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  const queries = []
  const original = Sqlite.prototype.prepare
  const restore = instrumentDatabase(Sqlite.prototype, query => queries.push(query))
  t.after(() => { restore(); db.close() })
  db.prepare('INSERT INTO item VALUES (?)').bind('one').run()
  assert.deepEqual(db.prepare('SELECT id FROM item WHERE id = ?').raw().all('one'), [['one']])
  assert.throws(() => db.prepare('SELECT missing FROM item'))
  assert.deepEqual(queries.map(query => query.params), [['one'], ['one'], []])
  restore()
  assert.equal(Sqlite.prototype.prepare, original)
})

test('raw D1 prepare/bind/all adapter captures actual bound native SQL', t => {
  const db = new Sqlite(':memory:')
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  const queries = []
  const restore = instrumentDatabase(Sqlite.prototype, query => queries.push(query))
  t.after(() => { restore(); db.close() })
  const d1 = { prepare(sql) { return { bind(...params) { return { all() { return { results: db.prepare(sql).all(...params) } } } } } } }
  const statement = registerQuerySource(d1.prepare('SELECT * FROM item WHERE id = ?'), { key: 'raw-d1-query', file: 'src/ws-do/src/raw.ts', line: 1 })
  assert.deepEqual(statement.bind('bot').all(), { results: [] })
  assert.equal(queries[0].source.key, 'raw-d1-query')
  assert.equal(queries[0].sql, 'SELECT * FROM item WHERE id = ?')
  assert.deepEqual(queries[0].params, ['bot'])
})

test('captured source sites are exact; other branches stay uncovered and reports omit bound values', t => {
  const root = process.cwd()
  const directory = mkdtempSync(join(tmpdir(), 'db-scan-capture-test-'))
  const db = new Sqlite(':memory:')
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  const capture = createCapture(root)
  const file = 'src/shared/src/db/queries/example.ts'
  const stack = `Error\n at query (${join(root, file)}:10:5)`
  capture.collect({ sql: 'SELECT * FROM item WHERE id = ?', params: ['private-bound-value'], stack })
  capture.write(directory)
  assert.equal(readdirSync(directory).length, 1)
  assert.equal(JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]))).records.length, 1)
  assert.equal(sourceFrames(root, stack)[0].line, 10)
  const inventory = { filesScanned: 1, sites: [{ key: 'observed', file, line: 10, endLine: 12 }, { key: 'unexecuted', file, line: 30, endLine: 35 }] }
  const report = buildReport(db, inventory, directory, 0)
  assert.equal(report.summary.observedSites, 1)
  assert.deepEqual(report.uncovered.map(site => site.key), ['unexecuted'])
  assert.equal(report.outcome, 'observed-queries-passed-with-coverage-gaps')
  assert.equal(JSON.stringify(report).includes('private-bound-value'), false)
  assert.equal(buildReport(db, inventory, directory, 1).outcome, 'failed')
})

test('source inventory uses DB method declarations and excludes Map/Array operations', () => {
  const file = 'src/shared/src/db/query-inventory-fixture.ts'
  const source = `import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'; type Database = BaseSQLiteDatabase<'sync', unknown>; export function query(db: Database) { const m = new Map(); m.delete('x'); Array.from(m); return db.select().from({} as never); }`
  const inventory = inventoryQueries(process.cwd(), { [file]: source })
  assert.deepEqual(inventory.sites.map(site => site.method), ['select'])
  assert.equal(inventory.sites[0].resolution, 'database-type')
})

test('deferred real Drizzle statements retain source without evaluating defaults twice', t => {
  const require = createRequire(new URL('../../src/shared/package.json', import.meta.url))
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const db = new Sqlite(':memory:')
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  let allocations = 0
  const table = sqliteTable('item', { id: text('id').primaryKey().$defaultFn(() => String(++allocations)) })
  const records = []
  const restore = instrumentDatabase(Sqlite.prototype, query => records.push(query))
  t.after(() => { restore(); db.close() })
  const orm = drizzle(db)
  const site = { key: 'deferred-query', file: 'src/shared/src/example.ts', line: 10 }
  const statement = registerQuerySource(orm.insert(table).values({}), site)
  assert.equal(allocations, 0)
  statement.run()
  assert.equal(allocations, 1)
  assert.equal(records[0].source.key, 'deferred-query')
  assert.deepEqual(records[0].params, ['1'])
})

test('normal insert FK parents are proved from actual indexed fixture rows; missing parents stay unknown', t => {
  const db = new Sqlite(':memory:')
  db.pragma('foreign_keys=ON')
  db.exec("CREATE TABLE person(id TEXT PRIMARY KEY, owner TEXT REFERENCES person(id)); CREATE TABLE old_child(person TEXT REFERENCES person(id)); CREATE TRIGGER read_only_guard BEFORE INSERT ON person WHEN NEW.owner IS NOT NULL BEGIN SELECT id FROM person WHERE id=NEW.owner; END; INSERT INTO person VALUES ('owner', NULL)")
  const records = []
  const restore = instrumentDatabase(Sqlite.prototype, query => records.push(query))
  t.after(() => { restore(); db.close() })
  const sql = 'INSERT INTO person (id, owner) VALUES (?, ?) RETURNING id'
  db.prepare(sql).run('bot', 'owner')
  assert.equal(records[0].context.insertedParentsSatisfied, true)
  const safe = analyzeQuery(db, sql, ['another', 'owner'], records[0].context)
  assert.deepEqual(safe.scans, [])
  assert.throws(() => db.prepare(sql).run('broken', 'missing'))
  const record = records.find(query => query.params[0] === 'broken')
  assert.equal(record.context.insertedParentsSatisfied, false)
  assert.equal(analyzeQuery(db, sql, record.params, record.context).scans.some(scan => scan.table === 'old_child'), true)
})
