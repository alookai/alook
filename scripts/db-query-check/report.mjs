import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { analyzeQuery, bindShape, normalizedSql, foreignKeyQueries } from './analyze.mjs'

function revive(value) {
  if (value?.bigint !== undefined) return BigInt(value.bigint)
  if (value?.blob !== undefined) return Buffer.from(value.blob, 'base64')
  return value
}

export function buildReport(db, inventory, directory, testExitCode) {
  const observations = []
  const testStatements = []
  const covered = new Set()
  const seen = new Set()
  const files = readdirSync(directory).filter(file => file.endsWith('.json'))
  for (const file of files) {
    const { records } = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    for (const record of records) {
      const identity = createHash('sha256').update(JSON.stringify(record)).digest('hex')
      if (seen.has(identity)) continue
      seen.add(identity)
      const sites = inventory.sites.filter(site => site.key === record.siteKey && site.instrumentation !== 'optional-chain-unverified')
      const fixture = record.fixtureSqlVerified && inventory.fixtureSites?.find(site => site.key === record.siteKey && site.resolution === 'database-type' && ['literal-sql', 'orm-builder'].includes(site.proof))
      if (!sites.length && fixture) {
        const statement = { source: { file: fixture.file, line: fixture.line }, site: fixture.key, proof: `${fixture.proof}; actual SQL matched`, sql: normalizedSql(record.sql), bindShape: bindShape(record.params.map(revive)), classification: 'test-injection', coverage: 'none; test constructions never cover product sites' }
        if (!testStatements.some(old => JSON.stringify(old) === JSON.stringify(statement))) testStatements.push(statement)
        continue
      }
      const analysis = analyzeQuery(db, record.sql, record.params.map(revive), record.context)
      for (const site of sites) if (!analysis.error) covered.add(site.key)
      const observation = { source: record.frames[0], sites: sites.map(site => site.key), attribution: sites.length === 1 ? 'exact-site' : 'unknown', classification: sites.length === 1 ? 'product-query' : 'unverified-origin', ...analysis }
      const equivalent = observations.find(old => JSON.stringify({ ...old, bindingCases: undefined }) === JSON.stringify(observation))
      if (equivalent) equivalent.bindingCases++
      else observations.push({ ...observation, bindingCases: 1 })
    }
  }
  const foreignKeys = foreignKeyQueries(db).map(query => ({ source: query.source, parent: query.parent, ...analyzeQuery(db, query.sql, query.params) }))
  const hazards = observations.filter(query => query.scans.length || query.unscopedSearches?.length || query.error)
  const unattributedStatements = observations.filter(query => query.attribution === 'unknown').length
  const uncovered = inventory.sites.filter(site => !covered.has(site.key))
  return {
    schemaVersion: 1,
    database: 'local SQLite with repository D1 migrations; no production connection',
    testExitCode,
    captureFiles: files.length,
    filesScanned: inventory.filesScanned,
    summary: { querySites: inventory.sites.length, observedSites: covered.size, uncoveredSites: uncovered.length, boundStatements: observations.length, unattributedStatements, testInjectedStatements: testStatements.length, foreignKeys: foreignKeys.length, schemaOnlyFkRisks: foreignKeys.filter(query => query.scans.length || query.unscopedSearches?.length || query.error).length, hazards: hazards.length },
    outcome: testExitCode || !files.length || !observations.length || hazards.length ? 'failed' : uncovered.length || unattributedStatements ? 'observed-queries-passed-with-coverage-gaps' : 'passed',
    limitations: ['Only executed SQL shapes and binding cases are analyzed; unexecuted branches are not proof of safety.', 'Test-only source instrumentation ties normal native prepares to the original query construction site; only an actual site identity counts as observed; stack lines are diagnostic, and unmatched/deferred paths remain uncovered.', 'Test injections require an exact typed test construction and matching literal or actual ORM-compiled SQL. Dynamic test adapter SQL is not proof of test origin. Test injections never cover product sites; unverified scans/compilation failures still fail the gate without claiming a proved product defect.', 'Node-native SQLite tests are captured; mocked-only and remote Worker DB execution remains uncovered.', 'Local SQLite plans do not prove production D1 latency or row counts.', 'Schema-only FK probes include retired tables and are reported separately; only actual observed parent operations determine whether a scan is reachable.', 'Potential scans are rejected conservatively; only recognized constant guards before any database access are proved unreachable.'],
    inventory: inventory.sites.map(site => ({ ...site, observed: covered.has(site.key) })),
    uncovered,
    observations,
    testStatements,
    foreignKeys: foreignKeys.map(query => ({ ...query, status: 'schema-only-potential; actual parent writes checked in observations' })),
  }
}

export function markdownReport(report) {
  const { summary } = report
  const sections = [`# Backend DB query scan check`, `Outcome: ${report.outcome}`, `Test process exit: ${report.testExitCode}; capture files: ${report.captureFiles}.`, `Query sites: ${summary.querySites}; observed: ${summary.observedSites}; uncovered: ${summary.uncoveredSites}. Bound statements: ${summary.boundStatements}; unattributed: ${summary.unattributedStatements}; test injections: ${summary.testInjectedStatements}; FK lookup plans: ${summary.foreignKeys}; hazards: ${summary.hazards}.`, '## Limits', ...report.limitations.map(line => `- ${line}`), '## Findings (unknown origins are unverified, not established product defects)']
  for (const query of report.observations.filter(query => query.error || query.scans.length || query.unscopedSearches?.length)) {
    const source = typeof query.source === 'string' ? query.source : `${query.source.file}:${query.source.line}`
    sections.push(`### ${source}`, `Classification: ${query.classification}`, `\`\`\`sql\n${query.sql}\n\`\`\``, `Bind shape: ${JSON.stringify(query.bindShape)}`, query.error ? `Compilation error: ${query.error}` : `Scans: ${JSON.stringify(query.scans)}; unscoped SEARCH: ${JSON.stringify(query.unscopedSearches ?? [])}`, `Plan: ${JSON.stringify(query.plan)}`)
  }
  sections.push('## Schema-only FK potential scans (not observed operations)', ...report.foreignKeys.filter(query => query.scans.length || query.unscopedSearches?.length || query.error).map(query => `- ${query.source}: ${JSON.stringify(query.scans)} ${query.error ?? ''}`))
  sections.push('## Unattributed observed statements', ...report.observations.filter(query => query.attribution === 'unknown').map(query => `- ${query.source.file}:${query.source.line}: ${query.sql}`))
  sections.push('## Proven test injections (not product coverage)', ...report.testStatements.map(query => `- ${query.source.file}:${query.source.line} (${query.proof}): ${query.sql}`))
  sections.push('## Uncovered source sites', ...report.uncovered.map(site => `- ${site.file}:${site.line} ${site.key} (${site.resolution}; ${site.instrumentation ?? 'construction'})`))
  return sections.join('\n\n') + '\n'
}
