import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Sqlite, analyzeQuery, foreignKeyQueries, normalizedSql } from './analyze.mjs'

function fixture(t) {
  const db = new Sqlite(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE owner (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE item (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES owner(id), name TEXT); CREATE INDEX item_owner ON item(owner_id);`)
  t.after(() => db.close())
  return db
}

test('WHERE and LIMIT do not hide full table or covering index scans', t => {
  const db = fixture(t)
  assert.equal(analyzeQuery(db, 'SELECT * FROM item WHERE name = ? LIMIT 1', ['match']).scans[0].table, 'item')
  const indexed = analyzeQuery(db, 'SELECT owner_id FROM item ORDER BY owner_id LIMIT 1')
  assert.equal(indexed.scans[0].access, 'index')
  assert.equal(indexed.scans[0].index, 'item_owner')
  assert.deepEqual(analyzeQuery(db, 'SELECT * FROM item WHERE owner_id = ?', ['one']).scans, [])
  assert.deepEqual(analyzeQuery(db, 'SELECT * FROM item WHERE owner_id > ? ORDER BY owner_id LIMIT 50', ['one']).scans, [])
  assert.equal(analyzeQuery(db, 'SELECT count(*) FROM item').scans[0].table, 'item')
})

test('physical cursor roots resolve nested aliases without confusing JSON and ephemeral scans', t => {
  const db = fixture(t)
  const sql = `WITH scoped AS MATERIALIZED (SELECT * FROM item WHERE owner_id = ?) SELECT * FROM scoped AS item WHERE EXISTS (SELECT 1 FROM owner AS item WHERE item.name = ?)`
  const result = analyzeQuery(db, sql, ['one', 'target'])
  assert.deepEqual([...new Set(result.scans.map(scan => scan.table))], ['owner'])
  assert.deepEqual(analyzeQuery(db, 'SELECT * FROM item AS x WHERE x.id IN (SELECT value FROM json_each(?))', ['["one"]']).scans, [])
  assert.deepEqual(analyzeQuery(db, 'WITH chosen(id) AS (VALUES (?),(?)) SELECT * FROM chosen', ['a', 'b']).scans, [])
})

test('implicit FK parent delete reveals an unindexed child scan', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE orphan_lookup (id TEXT PRIMARY KEY, owner_id TEXT REFERENCES owner(id))')
  const result = analyzeQuery(db, 'DELETE FROM owner WHERE id = ?', ['one'])
  assert.equal(result.scans.some(scan => scan.table === 'orphan_lookup'), true)
  const probes = foreignKeyQueries(db)
  assert.equal(probes.length, 2)
  assert.equal(probes.filter(probe => analyzeQuery(db, probe.sql, probe.params).scans.length).length, 1)
  db.exec('CREATE INDEX orphan_owner ON orphan_lookup(owner_id)')
  assert.deepEqual(analyzeQuery(db, 'DELETE FROM owner WHERE id = ?', ['one']).scans, [])
})

test('invalid SQL and missing binds remain errors; report SQL removes literal values', t => {
  const db = fixture(t)
  assert.match(analyzeQuery(db, 'SELECT * FROM not_a_table').error, /no such table/)
  assert.match(analyzeQuery(db, 'SELECT * FROM item WHERE id = ?').error, /few parameter/)
  assert.equal(normalizedSql("select * from item where name = 'private''value' limit 7"), 'select * from item where name = ? limit ?')
})

test('constant-false guards do not read the table despite SCAN in the high-level plan', t => {
  const db = fixture(t)
  for (const predicate of ['1=0', '0', '2 < 1']) {
    const result = analyzeQuery(db, `SELECT * FROM item WHERE ${predicate}`)
    assert.equal(result.plan.some(row => row.detail.includes('SCAN')), true)
    assert.deepEqual(result.scans, [])
    assert.match(result.noAccessProof, /constant guard/)
  }
  assert.equal(analyzeQuery(db, 'SELECT * FROM item WHERE 1=1').scans.length, 1)
})

test('unqualified deletion using SQLite Clear is a business table operation', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE unrelated(id TEXT PRIMARY KEY)')
  assert.equal(analyzeQuery(db, 'DELETE FROM unrelated').scans.some(scan => scan.opcode === 'Clear' && scan.table === 'unrelated'), true)
})

test('a constant-false delete skips row collection and consumes an empty row set', t => {
  const db = fixture(t)
  db.exec("INSERT INTO owner VALUES ('owner','Owner'); INSERT INTO item VALUES ('item','owner','Item')")
  const unreachable = 'DELETE FROM item WHERE 1=0'
  const bytecode = db.prepare(`EXPLAIN ${unreachable}`).all()
  assert.equal(bytecode.some(row => row.opcode === 'RowSetRead'), true)
  const guarded = analyzeQuery(db, unreachable)
  assert.equal(guarded.plan.some(row => row.detail.includes('SCAN item')), true)
  assert.deepEqual(guarded.scans, [])
  assert.match(guarded.noAccessProof, /constant guard/)
  assert.equal(db.prepare(unreachable).run().changes, 0)

  const reachable = analyzeQuery(db, 'DELETE FROM item WHERE 1=1')
  assert.equal(reachable.noAccessProof, undefined)
  assert.equal(reachable.scans.some(scan => scan.table === 'item'), true)

  const parameterGuard = analyzeQuery(db, 'DELETE FROM item WHERE ? = ?', [1, 0])
  assert.equal(parameterGuard.noAccessProof, undefined)
  assert.equal(parameterGuard.scans.some(scan => scan.table === 'item'), true)

  const collectsRows = 'DELETE FROM item WHERE name = ?'
  const rowSetBytecode = db.prepare(`EXPLAIN ${collectsRows}`).all('Item')
  assert.equal(rowSetBytecode.some(row => row.opcode === 'RowSetAdd'), true)
  const collected = analyzeQuery(db, collectsRows, ['Item'])
  assert.equal(collected.noAccessProof, undefined)
  assert.equal(collected.scans.some(scan => scan.table === 'item'), true)
  assert.equal(db.prepare(collectsRows).run('Item').changes, 1)

  db.exec('CREATE TRIGGER owner_removed AFTER DELETE ON owner BEGIN INSERT INTO item(id) VALUES (OLD.id); END')
  const separate = analyzeQuery(db, 'DELETE FROM owner WHERE name = ?', ['Owner'])
  assert.equal(separate.noAccessProof, undefined)
  assert.equal(separate.scans.some(scan => scan.table === 'owner'), true)
})

test('FK parent insert skips zero-counter blocks; pending deferred work and parent deletes stay hazardous', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE delayed_child(owner_id TEXT REFERENCES owner(id) DEFERRABLE INITIALLY DEFERRED)')
  const standalone = analyzeQuery(db, 'INSERT INTO owner(id) VALUES (?)', ['parent'], { inTransaction: false })
  assert.deepEqual(standalone.scans, [])
  assert.equal(standalone.skippedForeignKeyBlocks.length > 0, true)
  db.exec("BEGIN; INSERT INTO delayed_child VALUES ('parent')")
  const pending = analyzeQuery(db, 'INSERT INTO owner(id) VALUES (?)', ['parent'], { inTransaction: true })
  assert.equal(pending.scans.some(scan => scan.table === 'delayed_child'), true)
  db.prepare('INSERT INTO owner(id) VALUES (?)').run('parent')
  db.exec('COMMIT')
  assert.equal(analyzeQuery(db, 'DELETE FROM owner WHERE id=?', ['parent']).scans.some(scan => scan.table === 'delayed_child'), true)
})

test('PRAGMA-deferred immediate constraints prevent a false zero-counter proof', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE immediate_child(owner_id TEXT REFERENCES owner(id)); PRAGMA defer_foreign_keys=ON; BEGIN')
  db.prepare('INSERT INTO immediate_child VALUES (?)').run('future')
  const query = analyzeQuery(db, 'INSERT INTO owner(id) VALUES (?)', ['future'])
  assert.equal(query.scans.some(scan => scan.table === 'immediate_child'), true)
  db.prepare('INSERT INTO owner(id) VALUES (?)').run('future')
  db.exec('COMMIT')
})

test('a filtered anti-join with a limit can still scan the entire outer table', t => {
  const db = fixture(t)
  const result = analyzeQuery(db, 'SELECT id FROM item WHERE NOT EXISTS (SELECT 1 FROM owner WHERE owner.id = item.owner_id) LIMIT 10')
  assert.equal(result.scans.some(scan => scan.table === 'item'), true)
  assert.equal(result.error, undefined)
})

test('one-sided index and integer-primary-key ranges are bounded despite Rewind/Last starts', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE expiry(id INTEGER PRIMARY KEY, expires INTEGER NOT NULL); CREATE INDEX expiry_at ON expiry(expires)')
  for (const sql of ['SELECT * FROM expiry WHERE expires < ?', 'SELECT * FROM expiry WHERE expires > ? ORDER BY expires DESC', 'SELECT * FROM expiry WHERE id < ?', 'SELECT * FROM expiry WHERE id > ? ORDER BY id DESC']) {
    const result = analyzeQuery(db, sql, [100])
    assert.deepEqual(result.scans, [], sql)
    assert.equal(result.plan.some(row => row.detail.startsWith('SEARCH')), true)
  }
  assert.equal(analyzeQuery(db, 'SELECT expires FROM expiry ORDER BY expires LIMIT 1').scans.length > 0, true)
})

test('SEARCH by a boolean prefix does not prove user scope; primary-key and name ranges do', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER, name TEXT); CREATE INDEX user_kind ON user(isBot); CREATE INDEX user_name ON user(name); CREATE TABLE scoped(id TEXT PRIMARY KEY, user_id TEXT REFERENCES user(id), status TEXT); CREATE INDEX scoped_status ON scoped(status)')
  const broad = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_kind WHERE isBot=? AND id IN (SELECT value FROM json_each(?))', [0, '["selected"]'])
  assert.equal(broad.plan.some(row => row.detail.startsWith('SEARCH')), true)
  assert.equal(broad.unscopedSearches[0].table, 'user')
  assert.equal(analyzeQuery(db, 'SELECT * FROM scoped WHERE status=?', ['open']).unscopedSearches.length, 1)
  assert.deepEqual(analyzeQuery(db, 'SELECT id FROM user WHERE id=? AND isBot=0', ['selected']).unscopedSearches, [])
  assert.deepEqual(analyzeQuery(db, 'SELECT id FROM user WHERE name>=? AND name<?', ['ali', 'alj']).unscopedSearches, [])
})

test('an equality seek using only a flag and a literal NULL can traverse all live users', t => {
  const db = fixture(t)
  db.exec(`
    CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER, retired_at TEXT);
    CREATE INDEX user_active ON user(isBot, retired_at, id);
    CREATE INDEX user_retired ON user(retired_at);
  `)
  const broad = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL AND substr(id, 1, 1)=? LIMIT ?', [1, 'a', 5])
  assert.equal(broad.error, undefined)
  assert.deepEqual(broad.unscopedSearches.map(({index, columns}) => ({index, columns})), [
    {index: 'user_active', columns: ['isBot', 'retired_at']},
  ])
  const reverse = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL ORDER BY id DESC', [1])
  assert.equal(reverse.unscopedSearches.length, 1)
  const bounded = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL LIMIT ?', [1, 5])
  assert.deepEqual(bounded.unscopedSearches, [])
  assert.equal(bounded.boundedSearches[0].maxRows, 5)

  const timestamp = analyzeQuery(db, `SELECT id, NULL,
    (SELECT count(*) FROM user INDEXED BY user_retired WHERE retired_at IS NULL)
    FROM user INDEXED BY user_active WHERE isBot=? AND retired_at=?`, [1, '2026-01-01'])
  assert.equal(timestamp.error, undefined)
  assert.deepEqual(timestamp.unscopedSearches.map(({index}) => index), ['user_retired'])
  const scoped = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL AND id=?', [1, 'one'])
  assert.deepEqual(scoped.unscopedSearches, [])
  const range = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL AND id>?', [1, 'one'])
  assert.deepEqual(range.unscopedSearches, [])
})

test('a literal NULL seek is attributed to its own cursor when two aliases use the same index', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER, retired_at TEXT); CREATE INDEX user_active ON user(isBot, retired_at, id)')
  const sql = `SELECT id, (SELECT count(*) FROM user AS live_users INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL)
    FROM user AS dated_users INDEXED BY user_active WHERE isBot=? AND retired_at=?`
  const args = [1, 1, '2026-01-01']
  const result = analyzeQuery(db, sql, args)
  assert.equal(result.error, undefined)
  assert.equal(result.plan.filter(row => row.detail.includes('USING COVERING INDEX user_active (isBot=? AND retired_at=?)')).length, 2)
  assert.equal(result.unscopedSearches.length, 1)
  const [{ cursor, address, opcode }] = result.unscopedSearches
  const instructions = db.prepare(`EXPLAIN ${sql}`).all(...args)
  const seek = instructions.findIndex(row => row.addr === address && row.p1 === cursor && row.opcode === opcode)
  assert.ok(seek >= 2)
  assert.equal(opcode, 'SeekGE')
  assert.equal(instructions[seek - 2].opcode, 'Null')
  assert.equal(instructions[seek - 2].p2, instructions[seek].p3 + 1)
})

test('a scalar seek can return after the first visit even though it has no inner ResultRow', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER, retired_at TEXT); CREATE INDEX user_active ON user(isBot, retired_at, id)')
  const from = 'FROM user INDEXED BY user_active WHERE isBot=? AND retired_at IS NULL'
  const limited = analyzeQuery(db, `SELECT (SELECT id ${from} LIMIT ?)`, [1, 1])
  assert.equal(limited.error, undefined)
  assert.deepEqual(limited.unscopedSearches, [])
  assert.equal(limited.boundedSearches[0].maxRows, 1)
  const exists = analyzeQuery(db, `SELECT EXISTS (SELECT 1 ${from})`, [1])
  assert.deepEqual(exists.unscopedSearches, [])
  assert.equal(exists.boundedSearches[0].maxRows, 1)
  const residual = analyzeQuery(db, `SELECT (SELECT id ${from} AND substr(id, 1, 1)=? LIMIT ?)`, [1, 'z', 1])
  assert.equal(residual.unscopedSearches.length, 1)
  const offset = analyzeQuery(db, `SELECT (SELECT id ${from} ORDER BY id DESC LIMIT ? OFFSET ?)`, [1, 1, 10])
  assert.equal(offset.unscopedSearches.length, 1)
})

test('a scalar seek proves only its own bound when another iterator uses the same index', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER, retired_at TEXT); CREATE INDEX user_active ON user(isBot, retired_at, id)')
  const from = 'FROM user INDEXED BY user_active WHERE isBot=? AND retired_at'
  const bothLimited = analyzeQuery(db, `SELECT id, (SELECT id ${from} IS NULL LIMIT ?) ${from}=? LIMIT ?`, [1, 1, 1, '2026-01-01', 1])
  assert.equal(bothLimited.error, undefined)
  assert.deepEqual(bothLimited.unscopedSearches, [])
  assert.equal(bothLimited.boundedSearches[0].maxRows, 1)

  const bothNull = analyzeQuery(db, `SELECT id, (SELECT id ${from} IS NULL LIMIT ?) ${from} IS NULL AND substr(id, 1, 1)=? LIMIT ?`, [1, 1, 1, 'z', 1])
  assert.equal(bothNull.error, undefined)
  assert.equal(bothNull.unscopedSearches.length, 1)
  assert.equal(bothNull.boundedSearches.length, 1)
  assert.notEqual(bothNull.unscopedSearches[0].cursor, bothNull.boundedSearches[0].cursor)
})

test('a limited index stream is bounded only when no residual filter can skip output', t => {
  const db = fixture(t)
  db.exec('CREATE TABLE user(id TEXT PRIMARY KEY, isBot INTEGER); CREATE INDEX user_kind ON user(isBot)')
  const stream = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_kind WHERE isBot=? LIMIT ?', [0, 100])
  assert.deepEqual(stream.unscopedSearches, [])
  assert.equal(stream.boundedSearches[0].maxRows, 100)
  const residual = analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_kind WHERE isBot=? AND id IN (SELECT value FROM json_each(?)) LIMIT ?', [0, '["one"]', 100])
  assert.equal(residual.unscopedSearches.length, 1)
  assert.equal(analyzeQuery(db, 'SELECT id FROM user INDEXED BY user_kind WHERE isBot=? LIMIT ?', [0, -1]).unscopedSearches.length, 1)
})

test('persisted virtual-table access is explicitly unverified while JSON input remains distinct', t => {
  const db = fixture(t)
  db.exec('CREATE VIRTUAL TABLE documents USING fts5(title)')
  assert.match(analyzeQuery(db, 'SELECT * FROM documents WHERE documents MATCH ?', ['query']).error, /Persisted virtual table documents/)
  assert.equal(analyzeQuery(db, 'SELECT value FROM json_each(?)', ['["input"]']).error, undefined)
})
