import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Sqlite } from './analyze.mjs'
import { inventoryQueries } from './inventory.mjs'
import { buildReport } from './report.mjs'

test('new fixed D1 reads enter source plans and production-only edits alter their findings', t => {
  const root = process.cwd()
  const file = 'src/ws-do/src/source-plan-probe.ts'
  const fixture = "const QUERY = 'SELECT id FROM item WHERE id = ?'; export function read(db: D1Database) { return db.prepare(QUERY).bind('fixture-id') }"
  const omitted = "export function deferred(db: D1Database, id: string) { return db.prepare('SELECT id FROM item WHERE id = ?').bind(id) }"
  const directory = mkdtempSync(join(tmpdir(), 'db-source-plan-test-'))
  const db = new Sqlite(':memory:')
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  db.exec('CREATE TABLE item(id TEXT PRIMARY KEY, other TEXT)')
  const analyze = source => buildReport(db, inventoryQueries(root, { [file]: source }), directory, 0)

  assert.equal(analyze(omitted).sourcePlans.length, 0)
  const before = analyze(fixture + '\n' + omitted)
  assert.equal(before.sourcePlans.length, 1)
  assert.equal(before.sourcePlans[0].scans.length, 0)
  assert.equal(before.summary.sourcePlannedSites, 1)
  assert.equal(before.summary.observedSites, 0)
  assert.equal(before.uncovered.length, 1)

  const unsafe = fixture.replace(" WHERE id = ?", "").replace(".bind('fixture-id')", "")
  const after = analyze(unsafe + '\n' + omitted)
  assert.deepEqual(after.sourcePlans[0].sites, before.sourcePlans[0].sites)
  assert.deepEqual(after.sourcePlans[0].scans.map(scan => scan.table), ['item'])
  assert.equal(after.summary.hazards, 1)
  assert.equal(JSON.stringify(before).includes('fixture-id'), false)

  writeFileSync(join(directory, 'native.json'), JSON.stringify({ records: [{
    siteKey: before.sourcePlans[0].sites[0],
    frames: [before.sourcePlans[0].source],
    sql: 'SELECT id FROM item WHERE id = ?',
    params: ['fixture-id'],
  }] }))
  const combined = analyze(fixture + '\n' + omitted)
  assert.equal(combined.summary.observedSites, 1)
  assert.equal(combined.summary.sourcePlannedSites, 1)
  assert.equal(combined.summary.automaticCoveredSites, 1)
  assert.equal(combined.summary.automaticCoveragePercent, 50)
})

test('unsupported Drizzle calls stay visible without evaluating arbitrary functions', () => {
  const root = process.cwd()
  const file = 'src/shared/src/db/queries/source-plan-probe.ts'
  const source = `
    import { eq } from 'drizzle-orm'
    import { user } from '../schema'
    import type { Database } from '../index'
    function sideEffect() { throw new Error('would run arbitrary code') }
    export async function eligible(db: Database, id: string) { return await db.select({ id: user.id }).from(user).where(eq(user.id, id)) }
    export async function unsupported(db: Database) { return await db.select({ id: user.id }).from(user).where(eq(user.id, sideEffect())) }
    export function composable(db: Database, id: string) { return db.select({ id: user.id }).from(user).where(eq(user.id, id)) }
  `
  const inventory = inventoryQueries(root, { [file]: source })
  assert.equal(inventory.sites.length, 3)
  assert.equal(inventory.sourceDrizzlePlans.length, 1)
  assert.match(inventory.sourceDrizzlePlans[0].siteKey, /eligible:select:1$/)
})
