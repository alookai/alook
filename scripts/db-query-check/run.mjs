import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { inventoryQueries } from './inventory.mjs'
import { migratedDatabase } from './analyze.mjs'
import { buildReport, markdownReport } from './report.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: pnpm check:db-queries [--require-complete] [Vitest filters/options]\nRuns checker self-tests, backend native SQL capture, migrated SQLite plan checks, and source coverage inventory. Reports: .ci/db-query-check/report.{json,md}. --require-complete also fails on unobserved source sites.')
  process.exit(0)
}
const requireComplete = args.includes('--require-complete')
const filters = args.filter(value => value !== '--require-complete')
const output = resolve(root, '.ci/db-query-check')
const capture = mkdtempSync(join(tmpdir(), 'alook-db-query-check-'))
mkdirSync(output, { recursive: true })
for (const file of ['report.json', 'report.md', 'failure.json']) rmSync(join(output, file), { force: true })
let db
try {
  const selfTests = readdirSync(new URL('./', import.meta.url)).filter(file => file.endsWith('.test.mjs')).map(file => fileURLToPath(new URL(file, import.meta.url)))
  const checks = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selfTests], { cwd: root, stdio: 'inherit' })
  if (checks.error || checks.status !== 0) throw new Error('DB query checker self-tests failed', { cause: checks.error })
  const inventory = inventoryQueries(root)
  writeFileSync(join(capture, 'inventory.data'), JSON.stringify(inventory))
  console.log(`DB source inventory: ${inventory.sites.length} sites across ${inventory.filesScanned} source files`)
  const child = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'scripts/db-query-check/vitest.config.mjs', ...filters], { cwd: root, env: { ...process.env, ALOOK_DB_QUERY_CAPTURE_DIR: capture, ALOOK_DB_QUERY_ROOT: root, ALOOK_DB_QUERY_INVENTORY: join(capture, 'inventory.data') }, stdio: 'inherit' })
  db = migratedDatabase(root)
  const report = buildReport(db, inventory, capture, child.status ?? 1)
  const queryFiles = [...new Set(inventory.sites.map(site => site.file))].sort()
  const migrationFiles = readdirSync(resolve(root, 'src/web/migrations')).filter(file => file.endsWith('.sql')).sort().map(file => `src/web/migrations/${file}`)
  const toolFiles = readdirSync(new URL('./', import.meta.url)).filter(file => /\.(?:mjs|json|ts)$/.test(file)).sort().map(file => `scripts/db-query-check/${file}`)
  const hashFiles = files => {
    const hash = createHash('sha256')
    for (const file of files) hash.update(file).update('\0').update(readFileSync(resolve(root, file)))
    return hash.digest('hex')
  }
  report.source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), querySourceSha256: hashFiles(queryFiles), migrationsSha256: hashFiles(migrationFiles), checkerSha256: hashFiles(toolFiles), sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get().version }
  report.command = [process.execPath, ...process.argv.slice(1)]
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(output, 'report.md'), markdownReport(report))
  console.log(JSON.stringify({ outcome: report.outcome, ...report.summary, report: join(output, 'report.md') }))
  process.exitCode = report.outcome === 'failed' || requireComplete && (report.uncovered.length || report.summary.unattributedStatements) ? 1 : 0
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error.stack ?? error) }, null, 2))
  console.error(error)
  process.exitCode = 1
} finally {
  db?.close()
  rmSync(capture, { recursive: true, force: true })
}
