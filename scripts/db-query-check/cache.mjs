import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { productionFile } from './inventory.mjs'

export const CACHE_SCHEMA_VERSION = 'v1'

const EXTRA_CHECKER_FILES = [
  'scripts/ci/changed-scopes.mjs',
  'scripts/workspace-packages.mjs',
  'vitest.shared.ts',
  'src/shared/vitest.config.ts',
  'src/web/vitest.shared.ts',
  'src/web/vitest.config.ts',
  'src/web/auth/vitest.config.ts',
  'src/ws-do/vitest.config.ts',
  'src/email-worker/vitest.config.ts',
  'src/queue-worker/vitest.config.ts',
]

function walkMatchingFiles(root, relativeDirectory, filter) {
  const start = resolve(root, relativeDirectory)
  if (!existsSync(start)) return []
  const collected = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name)
      const relPath = relative(root, fullPath).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        if (/(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/.test(relPath)) continue
        visit(fullPath)
      } else if (filter(relPath)) {
        collected.push(relPath)
      }
    }
  }
  visit(start)
  return collected.sort()
}

export function hashFiles(root, files) {
  const hash = createHash('sha256')
  for (const file of [...new Set(files)].sort()) {
    hash.update(file).update('\0').update(readFileSync(resolve(root, file)))
  }
  return hash.digest('hex')
}

function readPackageVersionFromEntry(entryPath, expectedName) {
  let current = dirname(entryPath)
  while (true) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest.name === expectedName && typeof manifest.version === 'string') {
        return manifest.version
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`Unable to locate package.json for ${expectedName} from ${entryPath}`)
    }
    current = parent
  }
}

function resolveVersionFrom(fromManifest, packageName) {
  const require = createRequire(fromManifest)
  try {
    const manifestPath = require.resolve(`${packageName}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.name === packageName && typeof manifest.version === 'string') return manifest.version
  } catch {
    // Fall through to entry resolution when package exports hide ./package.json.
  }
  return readPackageVersionFromEntry(require.resolve(packageName), packageName)
}

export function resolveDependencyVersions(root) {
  const rootManifest = resolve(root, 'package.json')
  const sharedManifest = resolve(root, 'src/shared/package.json')
  const webManifest = resolve(root, 'src/web/package.json')
  const webRequire = createRequire(webManifest)
  const betterAuthEntry = webRequire.resolve('better-auth')
  const betterAuthRequire = createRequire(betterAuthEntry)
  const kyselyAdapterEntry = betterAuthRequire.resolve('@better-auth/kysely-adapter')
  const kyselyEntry = createRequire(kyselyAdapterEntry).resolve('kysely')

  return {
    '@better-auth/kysely-adapter': readPackageVersionFromEntry(kyselyAdapterEntry, '@better-auth/kysely-adapter'),
    'better-auth': readPackageVersionFromEntry(betterAuthEntry, 'better-auth'),
    'better-sqlite3': resolveVersionFrom(sharedManifest, 'better-sqlite3'),
    'drizzle-orm': resolveVersionFrom(sharedManifest, 'drizzle-orm'),
    kysely: readPackageVersionFromEntry(kyselyEntry, 'kysely'),
    typescript: resolveVersionFrom(rootManifest, 'typescript'),
    vitest: resolveVersionFrom(rootManifest, 'vitest'),
  }
}

export function collectSchemaAndDbFiles(root) {
  const files = walkMatchingFiles(
    root,
    'src/shared/src/db',
    relPath => /\.[cm]?[jt]sx?$/.test(relPath) && productionFile(relPath),
  )
  if (existsSync(resolve(root, 'src/web/src/lib/auth.ts'))) {
    files.push('src/web/src/lib/auth.ts')
  }
  return [...new Set(files)].sort()
}

export function collectExtraFixtureFiles(root) {
  const files = walkMatchingFiles(
    root,
    'src/shared/test/helpers',
    relPath => /\.[cm]?[jt]sx?$/.test(relPath) && !/\.d\.[cm]?[jt]s$/.test(relPath),
  )
  if (existsSync(resolve(root, 'src/web/src/test/community-sqlite-db.ts'))) {
    files.push('src/web/src/test/community-sqlite-db.ts')
  }
  return [...new Set(files)].sort()
}

// Mirrors the exact 6 Vitest project include/exclude rules in scripts/db-query-check/vitest.config.mjs.
export function collectBackendTestFiles(root) {
  const files = [
    ...walkMatchingFiles(root, 'src/shared/test', relPath => relPath.endsWith('.test.ts')),
    ...walkMatchingFiles(root, 'src/shared/src', relPath => relPath.endsWith('.test.ts')),
    ...walkMatchingFiles(
      root,
      'src/web/src',
      relPath =>
        /\.test\.tsx?$/.test(relPath)
        && !/\.dom\.test\.tsx?$/.test(relPath)
        && !relPath.startsWith('src/web/src/test/e2e/')
        && !relPath.startsWith('src/web/src/test/e2e-ui/')
        && !relPath.startsWith('src/web/src/test/architecture/')
        && !relPath.endsWith('.architecture.test.ts')
        && !/^src\/web\/src\/test\/e2e-[^/]+\.test\.ts$/.test(relPath),
    ),
    ...walkMatchingFiles(
      root,
      'src/web/auth',
      relPath => relPath.endsWith('.test.ts') && !relPath.startsWith('src/web/auth/test-runtime/'),
    ),
    ...walkMatchingFiles(
      root,
      'src/ws-do/src',
      relPath => relPath.endsWith('.test.ts') && !relPath.startsWith('src/ws-do/src/test-integration/'),
    ),
    ...walkMatchingFiles(root, 'src/email-worker/src', relPath => relPath.endsWith('.test.ts')),
    ...walkMatchingFiles(root, 'src/queue-worker/src', relPath => relPath.endsWith('.test.ts')),
  ]
  return [...new Set(files)].sort()
}

export function collectMigrationFiles(root) {
  const directory = resolve(root, 'src/web/migrations')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => `src/web/migrations/${file}`)
}

export function collectCheckerFiles(root) {
  const dir = resolve(root, 'scripts/db-query-check')
  const localFiles = existsSync(dir)
    ? readdirSync(dir)
        .filter(file => /\.(?:mjs|json|ts)$/.test(file))
        .sort()
        .map(file => `scripts/db-query-check/${file}`)
    : []
  const extras = EXTRA_CHECKER_FILES.filter(file => existsSync(resolve(root, file)))
  return [...new Set([...localFiles, ...extras])].sort()
}

export function computeInputFingerprint({
  root,
  queryFiles,
  fixtureFiles,
  workspaceDependencies = [],
  sqliteVersion,
  dependencyVersions = resolveDependencyVersions(root),
}) {
  const querySourceSha256 = hashFiles(root, queryFiles)
  const schemaAndDbSha256 = hashFiles(root, collectSchemaAndDbFiles(root))
  const testConstructionSourceSha256 = hashFiles(root, [...fixtureFiles, ...collectExtraFixtureFiles(root)])
  const backendTestsSha256 = hashFiles(root, collectBackendTestFiles(root))
  const migrationsSha256 = hashFiles(root, collectMigrationFiles(root))
  const checkerSha256 = hashFiles(root, collectCheckerFiles(root))
  const sortedWorkspaceLinks = [...workspaceDependencies].sort((left, right) =>
    `${left.consumer}\0${left.dependency}\0${left.target}`.localeCompare(
      `${right.consumer}\0${right.dependency}\0${right.target}`,
    ),
  )
  const sortedDependencies = Object.fromEntries(
    Object.keys(dependencyVersions)
      .sort()
      .map(key => [key, dependencyVersions[key]]),
  )
  const dependencyVersionsSha256 = createHash('sha256')
    .update(JSON.stringify({ packages: sortedDependencies, workspaceDependencies: sortedWorkspaceLinks }))
    .digest('hex')

  const components = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    querySourceSha256,
    schemaAndDbSha256,
    testConstructionSourceSha256,
    backendTestsSha256,
    migrationsSha256,
    checkerSha256,
    sqliteVersion,
    dependencyVersionsSha256,
  }
  const inputHash = createHash('sha256').update(JSON.stringify(components)).digest('hex')
  return { ...components, inputHash }
}

export function isStrictPassingReport(report) {
  return Boolean(
    report
    && typeof report === 'object'
    && report.outcome === 'passed'
    && report.testExitCode === 0
    && Array.isArray(report.uncovered)
    && report.uncovered.length === 0
    && report.summary
    && typeof report.summary === 'object'
    && report.summary.uncoveredSites === 0
    && report.summary.unattributedStatements === 0
    && report.summary.sourcePlanFailures === 0
    && report.summary.hazards === 0,
  )
}

export function fingerprintMatchesReport(report, fingerprint) {
  const source = report?.source
  if (!source || typeof source !== 'object') return false
  return (
    source.schemaVersion === fingerprint.schemaVersion
    && source.inputHash === fingerprint.inputHash
    && source.querySourceSha256 === fingerprint.querySourceSha256
    && source.schemaAndDbSha256 === fingerprint.schemaAndDbSha256
    && source.testConstructionSourceSha256 === fingerprint.testConstructionSourceSha256
    && source.backendTestsSha256 === fingerprint.backendTestsSha256
    && source.migrationsSha256 === fingerprint.migrationsSha256
    && source.checkerSha256 === fingerprint.checkerSha256
    && source.sqliteVersion === fingerprint.sqliteVersion
    && source.dependencyVersionsSha256 === fingerprint.dependencyVersionsSha256
  )
}

export function readValidCacheHit(cacheDir, fingerprint) {
  if (!cacheDir) return null
  const jsonPath = join(cacheDir, 'report.json')
  const mdPath = join(cacheDir, 'report.md')
  if (!existsSync(jsonPath) || !existsSync(mdPath)) return null
  let report
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    return null
  }
  if (!isStrictPassingReport(report) || !fingerprintMatchesReport(report, fingerprint)) {
    return null
  }
  return { report, markdown: readFileSync(mdPath, 'utf8') }
}

export function writeCacheEntry(cacheDir, report, markdown) {
  if (!cacheDir || !isStrictPassingReport(report)) return false
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(cacheDir, 'report.md'), markdown)
  return true
}

export function materializeCachedOutput(hit, { head, command, workspaceDependencies, fingerprint }) {
  const cachedFromHead = hit.report.source?.head ?? null
  const report = {
    ...hit.report,
    source: { ...hit.report.source, head },
    command,
    workspaceDependencies,
    cache: {
      hit: true,
      inputHash: fingerprint.inputHash,
      cachedFromHead,
    },
  }
  const banner = `> Cache hit: skipped full Vitest execution (input hash \`${fingerprint.inputHash}\`, cached from \`${cachedFromHead ?? 'unknown'}\`; workspace dependencies, checker self-tests, source inventory, and excluded-path guard were verified live).\n\n`
  const markdown = hit.markdown.startsWith('> Cache hit:') ? hit.markdown : `${banner}${hit.markdown}`
  return { report, markdown }
}
