import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  collectBackendTestFiles,
  computeInputFingerprint,
  fingerprintMatchesReport,
  isStrictPassingReport,
  materializeCachedOutput,
  readValidCacheHit,
  resolveDependencyVersions,
  writeCacheEntry,
} from './cache.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

function writeFixtureFile(root, relPath, content) {
  const target = join(root, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function makeTempProject() {
  const root = mkdtempSync(join(tmpdir(), 'alook-db-cache-test-'))
  writeFixtureFile(root, 'src/shared/src/db/schema.ts', 'export const users = { id: "id" }\n')
  writeFixtureFile(root, 'src/shared/src/db/queries/user.ts', 'export const findUser = () => "SELECT 1"\n')
  writeFixtureFile(root, 'src/web/src/lib/auth.ts', 'export const authConfig = { adapter: "kysely" }\n')
  writeFixtureFile(root, 'src/shared/test/helpers/migrated-db.ts', 'export const migrate = () => {}\n')
  writeFixtureFile(root, 'src/shared/test/queries/user.test.ts', 'export const fixture = 1\n')
  writeFixtureFile(root, 'src/web/migrations/0001_init.sql', 'CREATE TABLE user (id TEXT PRIMARY KEY);\n')
  writeFixtureFile(root, 'scripts/db-query-check/run.mjs', '// runner\n')
  writeFixtureFile(root, 'scripts/ci/changed-scopes.mjs', '// scopes\n')
  return root
}

const baseDeps = {
  '@better-auth/kysely-adapter': '1.7.0',
  'better-auth': '1.7.0',
  'better-sqlite3': '12.0.0',
  'drizzle-orm': '0.45.0',
  kysely: '0.28.0',
  typescript: '5.9.0',
  vitest: '5.1.0',
}

function makePassingReport(fingerprint, overrides = {}) {
  return {
    outcome: 'passed',
    testExitCode: 0,
    captureFiles: 4,
    summary: {
      querySites: 10,
      automaticCoveredSites: 10,
      automaticCoveragePercent: 100,
      observedSites: 10,
      sourcePlannedSites: 0,
      uncoveredSites: 0,
      boundStatements: 10,
      unattributedStatements: 0,
      testInjectedStatements: 0,
      sourcePlanFailures: 0,
      foreignKeys: 0,
      hazards: 0,
    },
    uncovered: [],
    observations: [],
    source: { head: 'abc1234', ...fingerprint },
    ...overrides,
  }
}

test('computeInputFingerprint is deterministic and sensitive to every input class', () => {
  const root = makeTempProject()
  try {
    const baseArgs = {
      root,
      queryFiles: ['src/shared/src/db/queries/user.ts'],
      fixtureFiles: ['src/shared/test/queries/user.test.ts'],
      workspaceDependencies: [{ consumer: 'src/web', dependency: '@alook/shared', target: 'src/shared' }],
      sqliteVersion: '3.50.0',
      dependencyVersions: baseDeps,
    }
    const initial = computeInputFingerprint(baseArgs)
    const repeat = computeInputFingerprint(baseArgs)
    assert.deepEqual(repeat, initial)
    assert.match(initial.inputHash, /^[0-9a-f]{64}$/)

    // Unrelated frontend files, DOM tests, and E2E specs do not perturb inputHash
    writeFixtureFile(root, 'src/web/src/components/button.tsx', 'export const Button = () => null\n')
    writeFixtureFile(root, 'src/web/src/components/button.dom.test.tsx', 'export const domTest = true\n')
    writeFixtureFile(root, 'src/web/src/test/e2e-ui/foo.spec.ts', 'export const e2eSpec = true\n')
    assert.equal(computeInputFingerprint(baseArgs).inputHash, initial.inputHash)

    // Changing sqliteVersion invalidates hash
    assert.notEqual(computeInputFingerprint({ ...baseArgs, sqliteVersion: '3.51.0' }).inputHash, initial.inputHash)

    // Changing dependency version invalidates hash
    assert.notEqual(
      computeInputFingerprint({ ...baseArgs, dependencyVersions: { ...baseDeps, 'drizzle-orm': '0.45.1' } }).inputHash,
      initial.inputHash,
    )

    // Changing schema, query, auth, helper, fixture, migration, or checker invalidates hash
    const mutations = [
      ['src/shared/src/db/schema.ts', 'export const users = { id: "id", email: "email" }\n', 'schemaAndDbSha256'],
      ['src/web/src/lib/auth.ts', 'export const authConfig = { adapter: "kysely", strict: true }\n', 'schemaAndDbSha256'],
      ['src/shared/src/db/queries/user.ts', 'export const findUser = () => "SELECT 2"\n', 'querySourceSha256'],
      ['src/shared/test/helpers/migrated-db.ts', 'export const migrate = () => true\n', 'testConstructionSourceSha256'],
      ['src/shared/test/queries/user.test.ts', 'export const fixture = 2\n', 'testConstructionSourceSha256'],
      ['src/web/migrations/0001_init.sql', 'CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT);\n', 'migrationsSha256'],
      ['scripts/db-query-check/run.mjs', '// runner v2\n', 'checkerSha256'],
    ]
    let previous = initial
    for (const [relPath, content, field] of mutations) {
      writeFixtureFile(root, relPath, content)
      const next = computeInputFingerprint(baseArgs)
      assert.notEqual(next[field], previous[field], `${relPath} must change ${field}`)
      assert.notEqual(next.inputHash, previous.inputHash, `${relPath} must change inputHash`)
      previous = next
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readValidCacheHit accepts only strictly passing matching reports and writeCacheEntry refuses failures', () => {
  const root = makeTempProject()
  const cacheDir = join(root, '.cache')
  try {
    const fingerprint = computeInputFingerprint({
      root,
      queryFiles: ['src/shared/src/db/queries/user.ts'],
      fixtureFiles: ['src/shared/test/queries/user.test.ts'],
      workspaceDependencies: [],
      sqliteVersion: '3.50.0',
      dependencyVersions: baseDeps,
    })

    const passing = makePassingReport(fingerprint)
    assert.equal(isStrictPassingReport(passing), true)
    assert.equal(fingerprintMatchesReport(passing, fingerprint), true)

    // Failed or incomplete reports are never cached
    const badVariants = [
      makePassingReport(fingerprint, { outcome: 'failed' }),
      makePassingReport(fingerprint, { testExitCode: 1 }),
      makePassingReport(fingerprint, { uncovered: [{ key: 'u1' }], summary: { ...passing.summary, uncoveredSites: 1 } }),
      makePassingReport(fingerprint, { summary: { ...passing.summary, unattributedStatements: 1 } }),
      makePassingReport(fingerprint, { summary: { ...passing.summary, sourcePlanFailures: 1 } }),
      makePassingReport(fingerprint, { summary: { ...passing.summary, hazards: 1 } }),
    ]
    for (const bad of badVariants) {
      assert.equal(isStrictPassingReport(bad), false)
      assert.equal(writeCacheEntry(cacheDir, bad, '# bad\n'), false)
    }

    // Valid write & read
    assert.equal(writeCacheEntry(cacheDir, passing, '# Backend DB query scan check\n'), true)
    const hit = readValidCacheHit(cacheDir, fingerprint)
    assert.ok(hit)
    const materialized = materializeCachedOutput(hit, {
      head: 'def5678',
      command: ['node', 'scripts/db-query-check/run.mjs', '--require-complete'],
      workspaceDependencies: [],
      fingerprint,
    })
    assert.equal(materialized.report.source.head, 'def5678')
    assert.deepEqual(materialized.report.cache, {
      hit: true,
      inputHash: fingerprint.inputHash,
      cachedFromHead: 'abc1234',
    })
    assert.match(materialized.markdown, /^> Cache hit: skipped full Vitest execution/)

    // Any mismatched fingerprint field rejects the cached report
    assert.equal(readValidCacheHit(cacheDir, { ...fingerprint, sqliteVersion: '3.51.0' }), null)
    assert.equal(readValidCacheHit(cacheDir, { ...fingerprint, inputHash: '0'.repeat(64) }), null)

    // Missing report.md or corrupt report.json rejects the cache
    rmSync(join(cacheDir, 'report.md'))
    assert.equal(readValidCacheHit(cacheDir, fingerprint), null)
    writeFileSync(join(cacheDir, 'report.md'), '# ok\n')
    writeFileSync(join(cacheDir, 'report.json'), '{not-json')
    assert.equal(readValidCacheHit(cacheDir, fingerprint), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('modifying or deleting a non-raw-SQL backend coverage test invalidates the cache', () => {
  const root = makeTempProject()
  const cacheDir = join(root, '.cache')
  const nonRawSqlTest = 'src/shared/test/queries/community-attention.test.ts'
  writeFixtureFile(root, nonRawSqlTest, 'import { createMigratedDb } from "../helpers/migrated-db"; export const ok = 1\n')
  try {
    const baseArgs = {
      root,
      queryFiles: ['src/shared/src/db/queries/user.ts'],
      // Deliberately NOT in fixtureFiles (mirrors helper-backed query tests with zero raw SQL literals)
      fixtureFiles: ['src/shared/test/queries/user.test.ts'],
      workspaceDependencies: [],
      sqliteVersion: '3.50.0',
      dependencyVersions: baseDeps,
    }
    const before = computeInputFingerprint(baseArgs)
    assert.equal(writeCacheEntry(cacheDir, makePassingReport(before), '# pass\n'), true)
    assert.ok(readValidCacheHit(cacheDir, before))

    // Editing the non-raw-SQL test invalidates backendTestsSha256 and misses cache
    writeFixtureFile(root, nonRawSqlTest, 'export const ok = 2 // removed DB call\n')
    const edited = computeInputFingerprint(baseArgs)
    assert.notEqual(edited.backendTestsSha256, before.backendTestsSha256)
    assert.notEqual(edited.inputHash, before.inputHash)
    assert.equal(readValidCacheHit(cacheDir, edited), null)

    // Deleting the non-raw-SQL test invalidates backendTestsSha256 and misses cache
    rmSync(join(root, nonRawSqlTest))
    const deleted = computeInputFingerprint(baseArgs)
    assert.notEqual(deleted.backendTestsSha256, before.backendTestsSha256)
    assert.notEqual(deleted.backendTestsSha256, edited.backendTestsSha256)
    assert.notEqual(deleted.inputHash, before.inputHash)
    assert.equal(readValidCacheHit(cacheDir, deleted), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveDependencyVersions and collectBackendTestFiles match the real repository', () => {
  const versions = resolveDependencyVersions(repoRoot)
  for (const name of [
    '@better-auth/kysely-adapter',
    'better-auth',
    'better-sqlite3',
    'drizzle-orm',
    'kysely',
    'typescript',
    'vitest',
  ]) {
    assert.match(versions[name], /^\d+\.\d+\.\d+/, `expected semver for ${name}, got ${versions[name]}`)
  }

  const backendTests = collectBackendTestFiles(repoRoot)
  assert.ok(backendTests.includes('src/shared/test/queries/community-attention.test.ts'))
  assert.ok(backendTests.includes('src/shared/test/queries/community-forum-counts.test.ts'))
  assert.ok(backendTests.every(file => !/\.dom\.test\.tsx?$/.test(file)))
  assert.ok(backendTests.every(file => !file.startsWith('src/web/src/test/e2e-ui/')))
})
