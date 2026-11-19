import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import { registerQuerySource, querySource, instrumentModule, sourceHook } from './source-context.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Sqlite, analyzeQuery } from './analyze.mjs'
import { prepareBatchStatement, instrumentDatabase, createCapture } from './capture.mjs'
import { sourceFrames, inventoryQueries } from './inventory.mjs'
import { buildReport } from './report.mjs'
import { instrumentBetterAuthQueries } from './dependency-source.mjs'

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

for (const Database of [Sqlite, createRequire(import.meta.url)('node:sqlite').DatabaseSync]) {
  test(`a literal fixture inside a product adapter keeps its own ${Database.name} statement origin`, t => {
    const root = process.cwd()
    const db = new Database(':memory:')
    db.exec('CREATE TABLE fixture_only(id TEXT); INSERT INTO fixture_only VALUES (\'one\')')
    const directory = mkdtempSync(join(tmpdir(), 'query-nested-fixture-'))
    const capture = createCapture(root)
    const restore = instrumentDatabase(Database.prototype, query => capture.collect(query))
    t.after(() => { restore(); db.close(); rmSync(directory, { recursive: true, force: true }) })
    const product = { key: 'outer-product', file: 'src/shared/src/db/queries/nested-fixture.ts', line: 1 }
    const fixture = { key: 'nested-fixture', file: 'src/shared/test/nested-fixture.test.ts', line: 1, kind: 'test-fixture', resolution: 'database-type', proof: 'literal-sql', literalSql: 'SELECT count(*) AS n FROM fixture_only' }
    const adapter = runInThisContext('(probe) => probe()', { filename: join(root, product.file) })
    const result = querySource.run(product, () => adapter(() => registerQuerySource(db.prepare(fixture.literalSql), fixture).get()))
    assert.equal(result.n, 1)
    capture.write(directory)
    const report = buildReport(db, { filesScanned: 1, sites: [product], fixtureSites: [fixture] }, directory, 0)
    assert.equal(report.testStatements.length, 1)
    assert.equal(report.summary.hazards, 0)
    assert.equal(report.summary.observedSites, 0)
    assert.deepEqual(report.uncovered.map(site => site.key), [product.key])
    assert.equal(report.outcome, 'failed')
  })
}

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

test('native batch keeps distinct query object origins and only covers verified executions', t => {
  const require = createRequire(new URL('../../src/shared/package.json', import.meta.url))
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const { eq } = require('drizzle-orm')
  const root = process.cwd()
  const directory = mkdtempSync(join(tmpdir(), 'db-query-batch-origin-'))
  const db = new Sqlite(':memory:')
  db.exec("CREATE TABLE item(id TEXT PRIMARY KEY); INSERT INTO item VALUES ('one')")
  const table = sqliteTable('item', { id: text('id').primaryKey() })
  const orm = drizzle(db)
  const capture = createCapture(root)
  const queries = []
  const transactions = []
  const restore = instrumentDatabase(Sqlite.prototype, query => {
    queries.push(query)
    transactions.push(db.inTransaction)
    capture.collect(query)
  })
  t.after(() => { restore(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  const file = 'src/shared/src/db/queries/batch-example.ts'
  const sites = ['first', 'second', 'prepare-only', 'wrong-params'].map(key => ({ key, file, line: 1 }))
  const fixture = { key: 'fixture', file: 'src/shared/test/batch-example.test.ts', line: 1, kind: 'test-fixture', proof: 'orm-builder', resolution: 'database-type' }
  const compiled = site => registerQuerySource(orm.select().from(table).where(eq(table.id, 'one')), site).toSQL()
  const [first, second, notExecuted, wrongParams] = sites.map(compiled)
  assert.notEqual(first, second)
  assert.deepEqual(first, second)
  prepareBatchStatement(db, notExecuted)
  assert.equal(queries.length, 0)
  const productFrame = runInThisContext('(probe) => probe()', { filename: join(root, file) })
  productFrame(() => querySource.run(sites[0], () => db.transaction(() => {
    for (const query of [first, second, compiled(fixture), { ...first }]) {
      assert.deepEqual(prepareBatchStatement(db, query).all(...query.params), [{ id: 'one' }])
    }
    assert.deepEqual(prepareBatchStatement(db, wrongParams).all('other'), [])
  })()))
  assert.deepEqual(queries.map(query => query.source?.key), ['first', 'second', 'fixture', undefined, undefined])
  assert.deepEqual(transactions, [true, true, true, true, true])
  capture.write(directory)
  const report = buildReport(db, { filesScanned: 1, sites, fixtureSites: [fixture] }, directory, 0)
  assert.deepEqual(report.inventory.filter(site => site.observed).map(site => site.key), ['first', 'second'])
  assert.equal(report.testStatements[0]?.site, fixture.key)
  assert.equal(report.testStatements.length, 1)
  assert.equal(report.summary.unattributedStatements, 1)
})

test('real Drizzle D1 batches require the original prepared statement, SQL and bindings', async t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const { drizzle } = require('drizzle-orm/d1')
  const { eq } = require('drizzle-orm')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const native = new Sqlite(':memory:')
  native.exec("CREATE TABLE item(id TEXT PRIMARY KEY); INSERT INTO item VALUES ('one')")
  const table = sqliteTable('item', { id: text('id').primaryKey() })
  const calls = []
  const restore = instrumentDatabase(Sqlite.prototype, call => calls.push(call))
  t.after(() => { restore(); native.close() })
  let mode
  const adapter = {
    prepare(sql) {
      let params
      const statement = {
        bind(...args) { params = args; return statement },
        execute() {
          const identity = mode === 'copy' ? { ...statement } : statement
          const prepared = prepareBatchStatement(native, identity, mode === 'sql' ? sql + ' ' : sql)
          return { results: prepared.all(...(mode === 'params' ? ['other'] : params)) }
        },
      }
      return statement
    },
    async batch(statements) { return native.transaction(() => statements.map(statement => statement.execute()))() },
  }
  const db = drizzle(adapter)
  const file = 'src/shared/src/db/queries/d1-batch-example.ts'
  const batch = runInThisContext('(invoke) => invoke()', { filename: join(root, file) })
  for (mode of ['actual', 'copy', 'sql', 'params']) {
    const site = { key: mode, file, line: 1 }
    const query = registerQuerySource(db.select().from(table).where(eq(table.id, 'one')), site)
    assert.deepEqual(await batch(() => db.batch([query])), mode === 'params' ? [[]] : [[{ id: 'one' }]])
  }
  assert.deepEqual(calls.map(call => call.source?.key), ['actual', undefined, undefined, undefined])
  assert.deepEqual(calls.map(call => call.params), [['one'], ['one'], ['one'], ['other']])
})

test('repository SQL through the Better Auth SQLite dialect keeps its own unknown origin', async t => {
  const root = process.cwd()
  const web = createRequire(join(root, 'src/web/package.json'))
  const auth = createRequire(web.resolve('better-auth'))
  const adapter = createRequire(auth.resolve('@better-auth/kysely-adapter'))
  const { Kysely } = await import(pathToFileURL(adapter.resolve('kysely')))
  const { NodeSqliteDialect } = await import(pathToFileURL(auth.resolve('@better-auth/kysely-adapter/node-sqlite-dialect')))
  const { DatabaseSync } = web('node:sqlite')
  const native = new DatabaseSync(':memory:')
  native.exec("CREATE TABLE item(id TEXT PRIMARY KEY); INSERT INTO item VALUES ('actual')")
  const db = new Kysely({ dialect: new NodeSqliteDialect({ database: native }) })
  const calls = []
  const restoreCapture = instrumentDatabase(DatabaseSync.prototype, call => calls.push(call))
  const restoreAuth = await instrumentBetterAuthQueries(root)
  t.after(async () => { restoreAuth(); restoreCapture(); await db.destroy() })
  const file = 'src/web/src/lib/kysely-probe.ts'
  const query = runInThisContext('(async (db) => await db.selectFrom("item").select("id").where("id", "=", "actual").execute())',
    { filename: join(root, file) })
  assert.deepEqual((await query(db)).map(row => row.id), ['actual'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].dependencySource, undefined)
  assert.deepEqual(calls[0].params, ['actual'])
  assert.equal(sourceFrames(root, calls[0].stack)[0]?.file, file)
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

test('source loading preserves raw data and optional short-circuiting while normal modules retain origins', t => {
  const root = process.cwd()
  const file = 'src/web/src/query-loader-probe.ts'
  const source = 'function run(registry) { return registry?.runtime.lifecycle.get().active }'
  const inventory = inventoryQueries(root, { [file]: source })
  assert.equal(inventory.sites.length, 1)
  assert.equal(inventory.sites[0].instrumentation, 'optional-chain-unverified')
  assert.equal(instrumentModule(source, join(root, file), root, inventory.sites), undefined)
  assert.equal(runInThisContext(`(${source})`)(undefined), undefined)
  const normal = 'function run(db) { return db.prepare("SELECT 1") }'
  const sites = inventoryQueries(root, { [file]: normal }).sites
  for (const suffix of ['?raw', '?raw=false', '?v=1&raw', '?url']) {
    assert.equal(instrumentModule(`export default ${JSON.stringify(normal)}`, join(root, file) + suffix, root, sites), undefined)
  }
  const previous = globalThis[sourceHook]
  const observed = []
  globalThis[sourceHook] = (builder, site) => { observed.push(site.key); return builder }
  t.after(() => { globalThis[sourceHook] = previous })
  const transformed = instrumentModule(normal, join(root, file) + '?v=1', root, sites)
  const result = {}
  assert.equal(runInThisContext(`(${transformed})`)({ prepare: () => result }), result)
  assert.deepEqual(observed, [sites[0].key])
})

test('optional receivers and methods preserve argument/getter short-circuits at terminal calls', t => {
  const root = process.cwd()
  const file = 'src/shared/src/optional-boundary.ts'
  const variants = [
    ['db?.select().from(payload.table).get()', undefined],
    ['db?.select().from(payload.table).get()', null],
    ['db.select?.().from(payload.table).get()', {}],
    ['db?.select?.().from(payload.table)?.get()', undefined],
    ['db?.select?.().from(payload.table)?.get()', {}],
    ['db?.select().from(payload.table)', undefined],
  ]
  const previous = globalThis[sourceHook]
  globalThis[sourceHook] = () => { throw new Error('optional source must remain uninstrumented') }
  t.after(() => { globalThis[sourceHook] = previous })
  for (const [expression, receiver] of variants) {
    const source = `function run(db, payload) { return ${expression} }`
    const inventory = inventoryQueries(root, { [file]: source })
    assert.equal(inventory.sites.length, 1)
    assert.equal(inventory.sites[0].instrumentation, 'optional-chain-unverified')
    const transformed = instrumentModule(source, join(root, file), root, inventory.sites)
    assert.equal(transformed, undefined)
    let reads = 0
    const payload = { get table() { reads++; throw new Error('unreached argument getter') } }
    assert.equal(runInThisContext(`(${transformed ?? source})`)(receiver, payload), undefined, expression)
    assert.equal(reads, 0, expression)
  }
})

test('optional real SQL retains binds, returned rows and lazy defaults; unknown scans still fail without coverage', t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const file = 'src/shared/src/optional-native.ts'
  const source = 'function run(db, table, payload) { return db?.insert(table).values(payload.value).returning().get() }'
  const select = 'function scan(db, table) { return db?.select().from(table).get() }'
  const inventory = inventoryQueries(root, { [file]: source + '\n' + select })
  assert.equal(inventory.sites.length, 2)
  assert.equal(inventory.sites.every(site => site.instrumentation === 'optional-chain-unverified'), true)
  const transformed = instrumentModule(source + '\n' + select, join(root, file), root, inventory.sites)
  assert.equal(transformed, undefined)
  const capture = createCapture(root)
  const directory = mkdtempSync(join(tmpdir(), 'query-optional-native-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  function execute(code, checked) {
    const db = new Sqlite(':memory:')
    db.exec('CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT)')
    let defaults = 0
    let getters = 0
    const table = sqliteTable('item', { id: text('id').primaryKey().$defaultFn(() => String(++defaults)), value: text('value') })
    const payload = { get value() { getters++; return { value: 'actual-bound-value' } } }
    const run = runInThisContext(`(${code})`, { filename: join(root, file) })
    const records = []
    const restore = instrumentDatabase(Sqlite.prototype, query => { records.push(query); if (checked) capture.collect(query) })
    try {
      assert.equal(run(undefined, table, payload), undefined)
      assert.equal(getters, 0)
      assert.equal(defaults, 0)
      const returned = run(drizzle(db), table, payload)
      const afterInsert = { getters, defaults, returned, queries: records.map(query => ({ sql: query.sql, params: query.params })) }
      assert.deepEqual(afterInsert, { getters: 1, defaults: 1, returned: { id: '1', value: 'actual-bound-value' }, queries: [{ sql: 'insert into "item" ("id", "value") values (?, ?) returning "id", "value"', params: ['1', 'actual-bound-value'] }] })
      if (checked) {
        assert.deepEqual(runInThisContext(`(${select})`, { filename: join(root, file) })(drizzle(db), table), returned)
        capture.write(directory)
        // Even a stale or overlapping wrapper's identity cannot certify an optional construction.
        const path = join(directory, readdirSync(directory)[0])
        const raw = JSON.parse(readFileSync(path))
        raw.records[0].siteKey = inventory.sites[0].key
        writeFileSync(path, JSON.stringify(raw))
        const report = buildReport(db, inventory, directory, 0)
        assert.equal(report.summary.observedSites, 0)
        assert.equal(report.summary.uncoveredSites, 2)
        assert.equal(report.summary.unattributedStatements, 2)
        assert.equal(report.summary.hazards, 1)
        assert.equal(report.observations.every(query => query.classification === 'unverified-origin'), true)
        assert.equal(report.outcome, 'failed')
      }
      return afterInsert
    } finally { restore(); db.close() }
  }
  assert.deepEqual(execute(transformed ?? source, true), execute(source, false))
})

test('a final SQL plan covers only subqueries consumed by the real compiler', t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { eq, exists } = require('drizzle-orm')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const sqlite = new Sqlite(':memory:')
  sqlite.exec('CREATE TABLE entry(id TEXT PRIMARY KEY); CREATE TABLE member(id TEXT PRIMARY KEY)')
  const db = drizzle(sqlite)
  const entry = sqliteTable('entry', { id: text('id').primaryKey() })
  const member = sqliteTable('member', { id: text('id').primaryKey() })
  const file = 'src/shared/src/db/queries/composition-probe.ts'
  const outerSite = { key: 'outer', file, line: 10 }
  const consumedSite = { key: 'consumed', file, line: 11 }
  const unusedSite = { key: 'unused', file, line: 12 }
  const capture = createCapture(root)
  const restore = instrumentDatabase(Sqlite.prototype, capture.collect)
  const directory = mkdtempSync(join(tmpdir(), 'db-composition-test-'))
  t.after(() => { restore(); sqlite.close(); rmSync(directory, { recursive: true, force: true }) })

  const consumed = registerQuerySource(db.select({ id: member.id }).from(member).where(eq(member.id, entry.id)), consumedSite)
  const unused = registerQuerySource(db.select({ id: member.id }).from(member).where(eq(member.id, 'other')), unusedSite)
  unused.getSQL()
  const statement = registerQuerySource(db.select().from(entry).where(exists(consumed)), outerSite)
  assert.deepEqual(statement.all(), [])

  capture.write(directory)
  const report = buildReport(sqlite, { filesScanned: 1, sites: [outerSite, consumedSite, unusedSite] }, directory, 0)
  assert.deepEqual(report.observations.map(query => query.sites), [[outerSite.key, consumedSite.key]])
  assert.deepEqual(report.uncovered.map(site => site.key), [unusedSite.key])
})

test('instrumentation reaches an aliased builder before Drizzle compiles the subquery', t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { eq } = require('drizzle-orm')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const db = new Sqlite(':memory:')
  db.exec("CREATE TABLE item(id TEXT PRIMARY KEY); INSERT INTO item VALUES ('one')")
  const table = sqliteTable('item', { id: text('id').primaryKey() })
  const file = 'src/shared/src/db/queries/alias-probe.ts'
  const source = `(db, table, eq) => {
    const used = db.select({ id: table.id }).from(table).where(eq(table.id, 'one')).as('used');
    db.select({ id: table.id }).from(table).where(eq(table.id, 'two')).as('unused');
    return db.select().from(used).all();
  }`
  const inventory = inventoryQueries(root, { [file]: source })
  assert.equal(inventory.sites.length, 3)
  const [used, unused, outer] = inventory.sites
  const directory = mkdtempSync(join(tmpdir(), 'db-alias-origin-'))
  const capture = createCapture(root)
  const previous = globalThis[sourceHook]
  globalThis[sourceHook] = registerQuerySource
  const restore = instrumentDatabase(Sqlite.prototype, capture.collect)
  t.after(() => {
    restore()
    globalThis[sourceHook] = previous
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const code = instrumentModule(source, join(root, file), root, inventory.sites)
  const execute = runInThisContext(`(${code})`, { filename: join(root, file) })
  assert.deepEqual(execute(drizzle(db), table, eq), [{ id: 'one' }])
  capture.write(directory)
  const report = buildReport(db, inventory, directory, 0)
  assert.deepEqual(report.observations.map(query => query.sites), [[outer.key, used.key]])
  assert.deepEqual(report.uncovered.map(site => site.key), [unused.key])
})

test('counts an actual compiler result separately from native execution', t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const ts = require('typescript')
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const native = new Sqlite(':memory:')
  native.exec('CREATE TABLE item(id TEXT PRIMARY KEY)')
  const orm = drizzle(native)
  const table = sqliteTable('item', { id: text('id').primaryKey() })
  const expected = orm.insert(table).values({ id: 'counted' }).toSQL()
  const file = 'src/shared/src/db/queries/parameter-count-probe.ts'
  const source = `
    import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
    import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
    export function fixture(db: BetterSQLite3Database, table: SQLiteTable) {
      const count = db.insert(table).values({ id: 'counted' }).toSQL().params.length;
      db.insert(table).values({ id: 'unused' });
      db.insert(table).values({ id: 'compiled' }).toSQL();
      db.insert(table).values({ id: 'written' }).run();
      return count;
    }
    export function countBinding(db: BetterSQLite3Database, table: SQLiteTable, id: unknown) {
      return db.insert(table).values({ id }).toSQL().params.length;
    }`
  const inventory = inventoryQueries(root, { [file]: source })
  assert.equal(inventory.sites.length, 5)
  const [counted, unused, compiled, written, countBinding] = inventory.sites
  assert.deepEqual(inventory.sites.filter(site => site.compilationOnly), [counted, countBinding])

  const directory = mkdtempSync(join(tmpdir(), 'db-parameter-count-'))
  const capture = createCapture(root)
  const previous = globalThis[sourceHook]
  globalThis[sourceHook] = capture.register
  const restore = instrumentDatabase(Sqlite.prototype, capture.collect)
  t.after(() => {
    restore()
    globalThis[sourceHook] = previous
    native.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const instrumented = instrumentModule(source, join(root, file), root, inventory.sites)
  const { outputText } = ts.transpileModule(instrumented, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
  const exported = {}
  runInThisContext(`(function (exports) { ${outputText}\n })`, { filename: join(root, file) })(exported)
  assert.equal(exported.fixture(orm, table), expected.params.length)
  assert.deepEqual(native.prepare('SELECT id FROM item').all(), [{ id: 'written' }])

  capture.write(directory)
  const { records } = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0])))
  const [compilation] = records.filter(record => record.compilationOnly)
  assert.equal(records.length, 2)
  assert.equal(compilation.siteKey, counted.key)
  assert.equal(compilation.sql, expected.sql)
  assert.deepEqual(compilation.params, expected.params)
  const report = buildReport(native, inventory, directory, 0)
  assert.deepEqual(report.compilationOnlyPlans.map(query => query.sites), [[counted.key]])
  assert.deepEqual(report.observations.map(query => query.sites), [[written.key]])
  assert.deepEqual(report.uncovered.map(site => site.key), [unused.key, compiled.key, countBinding.key])
  assert.deepEqual(report.inventory.filter(site => site.sourcePlanned).map(site => site.key), [counted.key])
  assert.deepEqual(report.inventory.filter(site => site.observed).map(site => site.key), [written.key])
  assert.equal(report.summary.hazards, 0)
  assert.equal(report.summary.sourcePlanFailures, 0)

  const invalidBinds = { ...compilation, params: [] }
  const invalidPath = join(directory, 'invalid-binds.json')
  writeFileSync(invalidPath, JSON.stringify({ records: [invalidBinds] }), { mode: 0o600 })
  const invalid = buildReport(native, inventory, directory, 0)
  assert.equal(invalid.outcome, 'failed')
  assert.equal(invalid.summary.sourcePlanFailures, 1)
  assert.equal(invalid.inventory.find(site => site.key === counted.key).sourcePlanned, false)
  assert.deepEqual(invalid.observations.map(query => query.sites), [[written.key]])

  rmSync(invalidPath)
  const date = new Date('2026-01-01')
  const dateQuery = orm.insert(table).values({ id: date }).toSQL()
  assert.equal(dateQuery.params[0], date)
  assert.throws(() => native.prepare(dateQuery.sql).run(...dateQuery.params), TypeError)
  const serializesAsText = { toJSON() { throw new Error('must not serialize unsupported bindings') } }
  assert.equal(exported.countBinding(orm, table, 'valid'), 1)
  assert.equal(exported.countBinding(orm, table, date), 1)
  assert.equal(exported.countBinding(orm, table, serializesAsText), 1)
  capture.write(directory)
  const unsupported = buildReport(native, inventory, directory, 0)
  assert.deepEqual(unsupported.sourcePlanFailures, [
    { siteKey: countBinding.key, reason: 'Unsupported binding at position 1 (object)' },
  ])
  assert.equal(unsupported.outcome, 'failed')
  assert.deepEqual(unsupported.compilationOnlyPlans.map(query => query.sites), [[counted.key], [countBinding.key]])
  assert.deepEqual(unsupported.inventory.filter(site => site.sourcePlanned).map(site => site.key), [counted.key])
  assert.deepEqual(unsupported.observations.map(query => query.sites), [[written.key]])
})

test('pure EXISTS compiles real binds without crediting unused or correlated builders', t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const ts = require('typescript')
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const native = new Sqlite(':memory:')
  native.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('one')")
  const orm = drizzle(native)
  const user = sqliteTable('user', { id: text('id').primaryKey() })
  const communityMention = sqliteTable('community_mention', { userId: text('user_id') })
  const file = 'src/shared/src/db/queries/standalone-exists-probe.ts'
  const source = `
    import { eq, exists, sql } from 'drizzle-orm';
    import type { Database } from '..';
    import { user } from '../schema';
    import { communityMention } from '../community-schema';
    export function standalone(db: Database, id: string) {
      return exists(db.select({ one: sql<number>\`1\` }).from(user).where(eq(user.id, id)));
    }
    export function unused(db: Database, id: string) {
      db.select({ id: user.id }).from(user).where(eq(user.id, id));
    }
    export function correlated(db: Database) {
      return exists(db.select({ id: user.id }).from(user).where(eq(user.id, communityMention.userId)));
    }`
  const inventory = inventoryQueries(root, { [file]: source })
  const [standalone, unused, correlated] = inventory.sites
  assert.equal(inventory.sites.length, 3)
  assert.deepEqual(inventory.sites.filter(site => site.compilationOnly), [standalone])
  const directory = mkdtempSync(join(tmpdir(), 'db-standalone-exists-'))
  const capture = createCapture(root)
  const previous = globalThis[sourceHook]
  globalThis[sourceHook] = capture.register
  t.after(() => {
    globalThis[sourceHook] = previous
    native.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const instrumented = instrumentModule(source, join(root, file), root, inventory.sites)
  const { outputText } = ts.transpileModule(instrumented, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
  const exported = {}
  runInThisContext(`(function (exports, require) { ${outputText}\n })`, { filename: join(root, file) })(
    exported, name => name === '../schema' ? { user } : name === '../community-schema' ? { communityMention } : require(name))
  assert.deepEqual(orm.select({ present: exported.standalone(orm, 'one') }).from(user).all(), [{ present: 1 }])
  exported.unused(orm, 'one')
  const invalid = orm.select({ present: exported.correlated(orm) }).from(user).toSQL()
  assert.throws(() => native.prepare(invalid.sql).all(...invalid.params), /no such column/)

  capture.write(directory)
  const { records } = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0])))
  assert.deepEqual(records.map(record => [record.siteKey, record.params]), [[standalone.key, ['one']]])
  const report = buildReport(native, inventory, directory, 0)
  assert.deepEqual(report.compilationOnlyPlans.map(query => [query.classification, query.sites]), [
    ['compiled-standalone-exists', [standalone.key]],
  ])
  assert.deepEqual(report.inventory.filter(site => site.sourcePlanned && !site.observed).map(site => site.key), [standalone.key])
  assert.deepEqual(report.uncovered.map(site => site.key), [unused.key, correlated.key])

  exported.standalone(orm, new Date('2026-01-01'))
  capture.write(directory)
  const failed = buildReport(native, inventory, directory, 0)
  assert.deepEqual(failed.sourcePlanFailures, [{ siteKey: standalone.key, reason: 'Unsupported binding at position 1 (object)' }])
  assert.equal(failed.inventory.find(site => site.key === standalone.key).sourcePlanned, false)

  let counterfeitCompilations = 0
  const counterfeitBuilder = {
    from() { return this },
    where() { return this },
    toSQL() { counterfeitCompilations++; return { sql: 'select id from user where id = ?', params: ['one'] } },
  }
  exported.standalone({ select: () => counterfeitBuilder }, 'one')
  capture.write(directory)
  const counterfeit = buildReport(native, inventory, directory, 0)
  assert.equal(counterfeitCompilations, 0)
  assert.ok(counterfeit.sourcePlanFailures.some(failure => failure.siteKey === standalone.key &&
    failure.reason === 'Expected an unmodified Drizzle SQLite select builder'))
  assert.equal(counterfeit.inventory.find(site => site.key === standalone.key).sourcePlanned, false)
})

test('native insert-select retains both typed positions and leaves unused builders uncovered', t => {
  const root = process.cwd()
  const require = createRequire(join(root, 'src/shared/package.json'))
  const ts = require('typescript')
  const { drizzle } = require('drizzle-orm/better-sqlite3')
  const { eq } = require('drizzle-orm')
  const { sqliteTable, text } = require('drizzle-orm/sqlite-core')
  const db = new Sqlite(':memory:')
  db.exec("CREATE TABLE original(id TEXT PRIMARY KEY); CREATE TABLE copied(id TEXT PRIMARY KEY); INSERT INTO original VALUES ('one')")
  const original = sqliteTable('original', { id: text('id').primaryKey() })
  const copied = sqliteTable('copied', { id: text('id').primaryKey() })
  const file = 'src/shared/src/db/queries/insert-select-probe.ts'
  const source = `(
    db: import('../index').Database,
    original: any,
    copied: any,
    eq: typeof import('drizzle-orm').eq,
  ) => {
    db.insert(copied).select(db.select({ id: original.id }).from(original).where(eq(original.id, 'unused')));
    return db.insert(copied).select(db.select({ id: original.id }).from(original).where(eq(original.id, 'one'))).run();
  }`
  const inventory = inventoryQueries(root, { [file]: source })
  assert.equal(inventory.sites.length, 6)
  assert.equal(inventory.sites.every(site => site.resolution === 'database-type'), true)
  const [unused, unusedInsert, unusedRead, used, usedInsert, usedRead] = inventory.sites
  assert.equal(unused.insertBuilderSiteKey, unusedInsert.key)
  assert.equal(used.insertBuilderSiteKey, usedInsert.key)
  const capture = createCapture(root)
  const directory = mkdtempSync(join(tmpdir(), 'db-insert-select-origin-'))
  const previous = globalThis[sourceHook]
  globalThis[sourceHook] = registerQuerySource
  const restore = instrumentDatabase(Sqlite.prototype, capture.collect)
  t.after(() => {
    restore()
    globalThis[sourceHook] = previous
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const instrumented = instrumentModule(source, join(root, file), root, inventory.sites)
  const { outputText } = ts.transpileModule(instrumented, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  const execute = runInThisContext(outputText, { filename: join(root, file) })
  assert.equal(execute(drizzle(db), original, copied, eq).changes, 1)
  restore()
  assert.deepEqual(db.prepare('SELECT id FROM copied').all(), [{ id: 'one' }])
  capture.write(directory)
  const report = buildReport(db, inventory, directory, 0)
  assert.deepEqual(report.observations.map(query => query.sites), [[used.key, usedInsert.key, usedRead.key]])
  assert.deepEqual(report.uncovered.map(site => site.key), [unused.key, unusedInsert.key, unusedRead.key])

  const mismatch = createCapture(root)
  const sql = report.observations[0].sql
  mismatch.collect({
    sql,
    params: ['one'],
    stack: '',
    source: { ...unused, compiled: { sql: sql + ' ', siteKeys: [unusedRead.key] } },
  })
  const mismatchDirectory = mkdtempSync(join(directory, 'mismatch-'))
  mismatch.write(mismatchDirectory)
  const failedMatch = buildReport(db, inventory, mismatchDirectory, 0)
  assert.deepEqual(failedMatch.observations.map(query => query.sites), [[unused.key]])
  assert.equal(failedMatch.inventory.find(site => site.key === unusedInsert.key).observed, false)
})
