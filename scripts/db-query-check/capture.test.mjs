import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import { registerQuerySource, querySource } from './source-context.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  capture.collect({ sql: 'SELECT * FROM item WHERE id = ?', params: ['private-bound-value'], stack, source: { key: 'observed', file, line: 10 } })
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

test('fixture-only SQL does not run FK context probes; production context is sampled before execution', t => {
  const root = process.cwd()
  const directory = mkdtempSync(join(tmpdir(), 'query-context-'))
  const db = new Sqlite(':memory:')
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  const capture = createCapture(root)
  const restore = instrumentDatabase(Sqlite.prototype, query => capture.collect(query))
  t.after(() => { restore(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  capture.collect({ sql: 'INSERT INTO item VALUES (?)', params: ['fixture'], stack: 'Error\n at fixture (/tmp/fixture.test.ts:1:1)', context: () => { throw new Error('fixture probe must not run') } })
  db.transaction(() => registerQuerySource({ run: () => db.prepare('SELECT * FROM item WHERE id=?').all('fixture') }, { key: 'actual', file: 'src/shared/src/db/queries/example.ts', line: 1 }).run())()
  capture.write(directory)
  const records = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]))).records
  assert.equal(records.length, 1)
  assert.equal(records[0].context.inTransaction, true)
  assert.equal(db.inTransaction, false)
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
  const safeContext = records[0].context()
  assert.equal(safeContext.insertedParentsSatisfied, true)
  const safe = analyzeQuery(db, sql, ['another', 'owner'], safeContext)
  assert.deepEqual(safe.scans, [])
  assert.throws(() => db.prepare(sql).run('broken', 'missing'))
  const record = records.find(query => query.params[0] === 'broken')
  const missingContext = record.context()
  assert.equal(missingContext.insertedParentsSatisfied, false)
  assert.equal(analyzeQuery(db, sql, record.params, missingContext).scans.some(scan => scan.table === 'old_child'), true)
})

test('source frames preserve Windows drive paths and encoded file URLs', () => {
  const root = 'C:\\qa\\repo'
  const expected = 'src/shared/src/db/queries/raw.ts'
  for (const stack of ['Error\n at query (C:\\qa\\repo\\src\\shared\\src\\db\\queries\\raw.ts:12:3)', 'Error\n at query (file:///C:/qa/repo/src/shared/src/db/queries/raw.ts:12:3)']) {
    assert.equal(sourceFrames(root, stack)[0].file, expected)
  }
  assert.equal(sourceFrames('/qa/my repo', 'Error\n at query (file:///qa/my%20repo/src/shared/src/raw.ts:5:2)')[0].file, 'src/shared/src/raw.ts')
})

test('same-line branches need their actual site identity; stack ranges never imply coverage', t => {
  const db = new Sqlite(':memory:')
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  const directory = mkdtempSync(join(tmpdir(), 'query-branch-coverage-'))
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  const file = 'src/shared/src/db/queries/same-line.ts'
  const inventory = { filesScanned: 1, sites: [{ key: 'executed', file, line: 1, endLine: 1 }, { key: 'unexecuted', file, line: 1, endLine: 1 }] }
  const record = { sql: 'SELECT * FROM item WHERE id=?', params: ['fixture'], siteKey: 'executed', frames: [{ file, line: 1, column: 5 }] }
  const path = join(directory, 'capture.json')
  writeFileSync(path, JSON.stringify({ records: [record] }))
  const exact = buildReport(db, inventory, directory, 0)
  assert.equal(exact.summary.observedSites, 1)
  assert.deepEqual(exact.uncovered.map(site => site.key), ['unexecuted'])
  writeFileSync(path, JSON.stringify({ records: [{ ...record, siteKey: undefined }] }))
  const ambiguous = buildReport(db, inventory, directory, 0)
  assert.equal(ambiguous.summary.observedSites, 0)
  assert.equal(ambiguous.summary.unattributedStatements, 1)
  assert.equal(ambiguous.outcome, 'observed-queries-passed-with-coverage-gaps')
})

test('D1 receiver names and aliases cannot change inventory; R2 remains a different service', () => {
  const sources = {
    'src/web/src/d1-alias.ts': `import type {D1Database as Store} from '@cloudflare/workers-types'; export function q(connection: Store) { return connection.prepare('SELECT 1'); }`,
    'src/web/src/d1-named.ts': `import type {D1Database} from '@cloudflare/workers-types'; export function q(db: D1Database) { return db.prepare('SELECT 1'); }`,
    'src/web/src/d1-global.ts': `export function q(connection: D1DatabaseSession) { return connection.prepare('SELECT 1'); }`,
    'src/web/src/r2-only.ts': `import type {R2Bucket} from '@cloudflare/workers-types'; export function q(connection: R2Bucket) { return connection.get('key'); }`,
  }
  const inventory = inventoryQueries(process.cwd(), sources)
  assert.equal(inventory.sites.length, 3)
  assert.equal(inventory.sites.every(site => site.method === 'prepare' && site.resolution === 'database-type'), true)
  const anySources = { 'src/web/src/unresolved.ts': `export function q(db: any, connection: any) { db.prepare('SELECT 1'); connection.prepare('SELECT 1'); }` }
  assert.equal(inventoryQueries(process.cwd(), anySources).sites.length, 2)
})

test('test provenance needs a typed ORM construction or literal SQL; adapter variables remain unproved', () => {
  const file = 'src/shared/test/provenance-fixture.test.ts'
  const source = `import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'; import type Sqlite from 'better-sqlite3'; export function q(db: BaseSQLiteDatabase<'sync', unknown>, sqlite: Sqlite.Database, unresolved: any, sql: string) { db.update({} as never).set({}); sqlite.prepare('SELECT * FROM item'); sqlite.prepare(sql); unresolved.prepare('SELECT * FROM item'); }`
  const inventory = inventoryQueries(process.cwd(), { [file]: source }, { includeFixtures: true })
  assert.equal(inventory.sites.length, 0)
  assert.deepEqual(inventory.fixtureSites.map(site => [site.method, site.proof]), [['update', 'orm-builder'], ['prepare', 'literal-sql']])
})

test('injected test SQL stays separate; product SQL through adapters and unknown SQL still fail the gate', t => {
  const previousStackLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 100
  t.after(() => { Error.stackTraceLimit = previousStackLimit })
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const fixtureDb = new Sqlite(':memory:')
  const productDb = new Sqlite(':memory:')
  fixtureDb.exec('CREATE TABLE fixture_only(id TEXT); CREATE TABLE item(id TEXT)')
  productDb.exec('CREATE TABLE item(id TEXT)')
  const directory = mkdtempSync(join(tmpdir(), 'query-injection-'))
  const capture = createCapture(root)
  const restore = instrumentDatabase(Sqlite.prototype, query => capture.collect(query))
  t.after(() => { restore(); fixtureDb.close(); productDb.close(); rmSync(directory, { recursive: true, force: true }) })
  const caller = runInThisContext('(execute) => execute()', { filename: join(root, 'src/shared/src/db/queries/injected-probe.ts') })
  const file = 'src/shared/test/injected-probe.test.ts'
  const ormSite = { key: 'fixture-orm', file, line: 1, kind: 'test-fixture', resolution: 'database-type', proof: 'orm-builder' }
  const literalSite = { ...ormSite, key: 'fixture-literal', proof: 'literal-sql', literalSql: 'SELECT * FROM fixture_only' }
  let allocations = 0
  const table = sqliteTable('fixture_only', { id: text('id').$defaultFn(() => `test-only-value-${++allocations}`) })
  const injected = registerQuerySource(drizzle(fixtureDb).insert(table).values({}), ormSite)
  assert.equal(allocations, 0)
  injected.run()
  caller(() => injected.run())
  assert.equal(allocations, 2)
  const literal = registerQuerySource(fixtureDb.prepare('SELECT * FROM fixture_only'), literalSite)
  caller(() => literal.all())
  const production = { key: 'product', file: 'src/shared/src/db/queries/injected-probe.ts', line: 1 }
  const productStatement = querySource.run(production, () => fixtureDb.prepare('SELECT * FROM item'))
  registerQuerySource(productStatement, literalSite)
  caller(() => productStatement.all())
  const unknown = querySource.run(literalSite, () => fixtureDb.prepare('SELECT id FROM fixture_only'))
  caller(() => unknown.all())
  capture.write(directory)
  const inventory = { filesScanned: 1, sites: [production], fixtureSites: [ormSite, literalSite] }
  const report = buildReport(productDb, inventory, directory, 0)
  assert.equal(report.testStatements.length, 2, JSON.stringify({ fixtures: report.testStatements, observations: report.observations }))
  assert.equal(report.summary.observedSites, 1)
  assert.equal(report.summary.hazards, 2)
  assert.equal(report.observations.find(query => query.classification === 'product-query').scans.length, 1)
  assert.match(report.observations.find(query => query.classification === 'unverified-origin').error, /no such table/)
  assert.equal(report.outcome, 'failed')
  assert.equal(JSON.stringify(report).includes('test-only-value'), false)
  const path = join(directory, readdirSync(directory)[0])
  const { records } = JSON.parse(readFileSync(path))
  assert.equal(records.length, 4)
  writeFileSync(path, JSON.stringify({ records: records.filter(record => record.siteKey?.startsWith('fixture-')) }))
  const fixturesOnly = buildReport(productDb, inventory, directory, 0)
  assert.equal(fixturesOnly.summary.observedSites, 0)
  assert.equal(fixturesOnly.outcome, 'failed')
})
