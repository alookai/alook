import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'
import { isDbQueryCheckPath } from '../ci/changed-scopes.mjs'
import { inventoryQueries } from './inventory.mjs'
import { Sqlite, migratedDatabase } from './analyze.mjs'
import {
  computeInputFingerprint,
  isStrictPassingReport,
  materializeCachedOutput,
  readValidCacheHit,
  writeCacheEntry,
} from './cache.mjs'
import { buildReport, markdownReport } from './report.mjs'
import { verifyWorkspaceDependencies } from './workspace.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: pnpm check:db-queries [--require-complete] [--print-input-hash] [Vitest filters/options]\nRuns checker self-tests, backend native SQL capture, migrated SQLite plan checks, and source coverage inventory. Reports: .ci/db-query-check/report.{json,md}. --require-complete also fails on unobserved source sites or unattributed SQL. --print-input-hash prints the exact cache key after verifying workspace dependencies, inventory, and excluded-path guard.')
  process.exit(0)
}
const printInputHash = args.includes('--print-input-hash')
const requireComplete = args.includes('--require-complete')
const filters = args.filter(value => value !== '--require-complete' && value !== '--print-input-hash')

function readSqliteVersion() {
  const probe = new Sqlite(':memory:')
  try {
    return probe.prepare('SELECT sqlite_version() AS version').get().version
  } finally {
    probe.close()
  }
}

if (printInputHash) {
  const workspaceDependencies = verifyWorkspaceDependencies(root)
  const inventory = inventoryQueries(root, undefined, { includeFixtures: true })
  const queryFiles = [...new Set(inventory.sites.map(site => site.file))].sort()
  const excludedQueryFiles = queryFiles.filter(file => !isDbQueryCheckPath(file))
  if (excludedQueryFiles.length) throw new Error(`Production SQL in directories excluded from automatic DB checks: ${excludedQueryFiles.join(', ')}`)
  const fixtureFiles = [...new Set(inventory.fixtureSites.map(site => site.file))].sort()
  const fingerprint = computeInputFingerprint({
    root,
    queryFiles,
    fixtureFiles,
    workspaceDependencies,
    sqliteVersion: readSqliteVersion(),
  })
  console.log(fingerprint.inputHash)
  process.exit(0)
}

const output = resolve(root, '.ci/db-query-check')
const capture = mkdtempSync(join(tmpdir(), 'alook-db-query-check-'))
mkdirSync(output, { recursive: true })
for (const file of ['report.json', 'report.md', 'failure.json']) rmSync(join(output, file), { force: true })
let db
try {
  const workspaceDependencies = verifyWorkspaceDependencies(root)
  const selfTests = readdirSync(new URL('./', import.meta.url)).filter(file => file.endsWith('.test.mjs')).map(file => fileURLToPath(new URL(file, import.meta.url)))
  const checks = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selfTests], { cwd: root, stdio: 'inherit' })
  if (checks.error || checks.status !== 0) throw new Error('DB query checker self-tests failed', { cause: checks.error })
  const inventory = inventoryQueries(root, undefined, { includeFixtures: true })
  const queryFiles = [...new Set(inventory.sites.map(site => site.file))].sort()
  const excludedQueryFiles = queryFiles.filter(file => !isDbQueryCheckPath(file))
  if (excludedQueryFiles.length) throw new Error(`Production SQL in directories excluded from automatic DB checks: ${excludedQueryFiles.join(', ')}`)
  const fixtureFiles = [...new Set(inventory.fixtureSites.map(site => site.file))].sort()
  const fingerprint = computeInputFingerprint({
    root,
    queryFiles,
    fixtureFiles,
    workspaceDependencies,
    sqliteVersion: readSqliteVersion(),
  })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const cacheDir = process.env.ALOOK_DB_QUERY_CACHE_DIR?.trim() ? resolve(root, process.env.ALOOK_DB_QUERY_CACHE_DIR.trim()) : ''
  const forceFull = process.env.ALOOK_DB_QUERY_FORCE_FULL === '1'
  console.log(`DB source inventory: ${inventory.sites.length} sites across ${inventory.filesScanned} source files (input hash ${fingerprint.inputHash.slice(0, 12)})`)

  const cacheHit = !forceFull && filters.length === 0 ? readValidCacheHit(cacheDir, fingerprint) : null
  if (cacheHit) {
    const materialized = materializeCachedOutput(cacheHit, {
      head,
      command: [process.execPath, ...process.argv.slice(1)],
      workspaceDependencies,
      fingerprint,
    })
    writeFileSync(join(output, 'report.json'), JSON.stringify(materialized.report, null, 2) + '\n')
    writeFileSync(join(output, 'report.md'), materialized.markdown)
    console.log(JSON.stringify({ outcome: materialized.report.outcome, cacheHit: true, inputHash: fingerprint.inputHash, ...materialized.report.summary, report: join(output, 'report.md') }))
    process.exitCode = 0
  } else {
    writeFileSync(join(capture, 'inventory.data'), JSON.stringify(inventory))
    const child = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'scripts/db-query-check/vitest.config.mjs', ...filters], { cwd: root, env: { ...process.env, ALOOK_DB_QUERY_CAPTURE_DIR: capture, ALOOK_DB_QUERY_ROOT: root, ALOOK_DB_QUERY_INVENTORY: join(capture, 'inventory.data') }, stdio: 'inherit' })
    db = migratedDatabase(root)
    const report = buildReport(db, inventory, capture, child.status ?? 1)
    report.source = { head, ...fingerprint }
    report.cache = { hit: false, inputHash: fingerprint.inputHash, forcedFull: forceFull }
    report.command = [process.execPath, ...process.argv.slice(1)]
    report.workspaceDependencies = workspaceDependencies
    const markdown = markdownReport(report)
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    writeFileSync(join(output, 'report.md'), markdown)
    if (cacheDir && filters.length === 0 && isStrictPassingReport(report)) {
      writeCacheEntry(cacheDir, report, markdown)
    }
    console.log(JSON.stringify({ outcome: report.outcome, cacheHit: false, inputHash: fingerprint.inputHash, ...report.summary, report: join(output, 'report.md') }))
    process.exitCode = report.outcome === 'failed' || requireComplete && (report.uncovered.length || report.summary.unattributedStatements || report.summary.sourcePlanFailures) ? 1 : 0
  }
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error.stack ?? error) }, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  db?.close()
  rmSync(capture, { recursive: true, force: true })
}
