import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { analyzeQuery, bindShape, normalizedSql, foreignKeyQueries } from './analyze.mjs'

function revive(value) {
  if (value?.bigint !== undefined) return BigInt(value.bigint)
  if (value?.blob !== undefined) return Buffer.from(value.blob, 'base64')
  return value
}

function addBindingCase(queries, query) {
  const equivalent = queries.find(old => JSON.stringify({ ...old, bindingCases: undefined }) === JSON.stringify(query))
  if (equivalent) equivalent.bindingCases++
  else queries.push({ ...query, bindingCases: 1 })
}

export function buildReport(db, inventory, directory, testExitCode) {
  const observations = []
  const testStatements = []
  const compilationOnlyPlans = []
  const compilationOnlyFailures = []
  const covered = new Set()
  const seen = new Set()
  const files = readdirSync(directory).filter(file => file.endsWith('.json'))
  for (const file of files) {
    const { records } = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    for (const record of records) {
      const identity = createHash('sha256').update(JSON.stringify(record)).digest('hex')
      if (seen.has(identity)) continue
      seen.add(identity)
      const site = inventory.sites.find(candidate => candidate.key === record.siteKey && candidate.instrumentation !== 'optional-chain-unverified')
      if (record.compilationOnly) {
        if (site?.compilationOnly !== record.compilationOnly) {
          compilationOnlyFailures.push({ siteKey: record.siteKey, reason: 'No matching typed construction for captured compilation' })
          continue
        }
        if (record.compilationError) {
          compilationOnlyFailures.push({ siteKey: site.key, reason: record.compilationError })
          continue
        }
        const plan = analyzeQuery(db, record.sql, record.params.map(revive))
        addBindingCase(compilationOnlyPlans, {
          source: { file: site.file, line: site.line },
          sites: [site.key],
          attribution: 'exact-site',
          classification: record.compilationOnly === 'standalone-exists' ? 'compiled-standalone-exists' : 'compiled-for-parameter-count',
          ...plan,
        })
        if (plan.error) compilationOnlyFailures.push({ siteKey: site.key, reason: plan.error })
        continue
      }
      const parts = new Set(site ? record.composedSiteKeys : [])
      const sites = site ? [site, ...inventory.sites.filter(candidate => parts.has(candidate.key) && candidate.instrumentation !== 'optional-chain-unverified')] : []
      const fixture = record.fixtureSqlVerified && inventory.fixtureSites?.find(site => site.key === record.siteKey && site.resolution === 'database-type' && ['literal-sql', 'orm-builder'].includes(site.proof))
      if (!sites.length && fixture) {
        const statement = { source: { file: fixture.file, line: fixture.line }, site: fixture.key, proof: `${fixture.proof}; actual SQL matched`, sql: normalizedSql(record.sql), bindShape: bindShape(record.params.map(revive)), classification: 'test-injection', coverage: 'none; test constructions never cover product sites' }
        if (!testStatements.some(old => JSON.stringify(old) === JSON.stringify(statement))) testStatements.push(statement)
        continue
      }
      const analysis = analyzeQuery(db, record.sql, record.params.map(revive), record.context)
      for (const site of sites) if (!analysis.error) covered.add(site.key)
      const dependencySource = site ? undefined : record.dependencySource
      const observation = {
        source: record.frames[0], sites: sites.map(site => site.key), dependencySource,
        attribution: site ? 'exact-site' : dependencySource ? 'exact-dependency' : 'unknown',
        classification: site ? 'product-query' : dependencySource ? 'dependency-query' : 'unverified-origin',
        ...analysis,
      }
      addBindingCase(observations, observation)
    }
  }
  const compiledSource = join(directory, 'source-drizzle.data')
  const drizzle = existsSync(compiledSource) ? JSON.parse(readFileSync(compiledSource, 'utf8')) : { statements: [], failures: (inventory.sourceDrizzlePlans ?? []).map(plan => ({ siteKey: plan.siteKey, reason: 'Drizzle source compilation did not run' })) }
  const sourcePlanFailures = [...drizzle.failures, ...compilationOnlyFailures]
  const failedSourceSites = new Set(sourcePlanFailures.map(failure => failure.siteKey))
  const sourcePlans = [...inventory.sourceStatements ?? [], ...drizzle.statements].map(statement => {
    const site = inventory.sites.find(candidate => candidate.key === statement.siteKey)
    return {
      source: { file: site.file, line: site.line },
      sites: [site.key],
      attribution: 'exact-site',
      classification: 'source-plan',
      ...analyzeQuery(db, statement.sql, statement.params),
    }
  })
  for (const plan of sourcePlans) if (plan.error) for (const key of plan.sites) failedSourceSites.add(key)
  const allSourcePlans = [...sourcePlans, ...compilationOnlyPlans]
  const planned = new Set(allSourcePlans.flatMap(plan => plan.sites.filter(key => !failedSourceSites.has(key))))
  const foreignKeys = foreignKeyQueries(db).map(query => ({ source: query.source, parent: query.parent, ...analyzeQuery(db, query.sql, query.params) }))
  const isHazard = query => query.scans.length || query.unscopedSearches?.length || query.error
  const hazards = [...observations, ...allSourcePlans].filter(isHazard)
  const unattributedStatements = observations.filter(query => query.attribution === 'unknown').length
  const uncovered = inventory.sites.filter(site => !covered.has(site.key) && !planned.has(site.key))
  const automaticCoveredSites = inventory.sites.length - uncovered.length
  const automaticCoveragePercent = inventory.sites.length ? Number((100 * automaticCoveredSites / inventory.sites.length).toFixed(1)) : 0
  const queryShapes = [...Map.groupBy([...observations, ...allSourcePlans].filter(query => query.sites.length), query => query.sites[0])]
    .map(([site, queries]) => ({
      site,
      observed: new Set(queries.filter(query => query.classification === 'product-query').map(query => query.sql)).size,
      source: new Set(queries.filter(query => query.classification !== 'product-query').map(query => query.sql)).size,
    }))
    .filter(entry => entry.observed > 1 || entry.source > 1)
  return {
    schemaVersion: 1,
    database: 'local SQLite with repository D1 migrations; no production connection',
    testExitCode,
    captureFiles: files.length,
    filesScanned: inventory.filesScanned,
    summary: { automaticCoveredSites, automaticCoveragePercent, sourcePlannedSites: planned.size, sourcePlanFailures: sourcePlanFailures.length, querySites: inventory.sites.length, observedSites: covered.size, uncoveredSites: uncovered.length, boundStatements: observations.length, unattributedStatements, testInjectedStatements: testStatements.length, foreignKeys: foreignKeys.length, schemaOnlyFkRisks: foreignKeys.filter(query => query.scans.length || query.unscopedSearches?.length || query.error).length, hazards: hazards.length },
    outcome: testExitCode || !files.length || !observations.length || hazards.length || compilationOnlyFailures.length ? 'failed' : uncovered.length || unattributedStatements || sourcePlanFailures.length ? 'observed-queries-passed-with-coverage-gaps' : 'passed',
    limitations: ['Runtime observations and fixed source plans are separate evidence. Unverified statements and branches are not proof of safety.', 'Test-only source instrumentation ties normal native prepares to the original query construction site; only an actual site identity counts as observed; stack lines are diagnostic, and unmatched/deferred paths remain uncovered.', 'Test injections require an exact typed test construction and matching literal or actual ORM-compiled SQL. Dynamic test adapter SQL is not proof of test origin. Test injections never cover product sites; unverified scans/compilation failures still fail the gate without claiming a proved product defect.', 'Node-native SQLite tests are captured; mocked-only and remote Worker DB execution remains uncovered.', 'Local SQLite plans do not prove production D1 latency or row counts.', 'Schema-only FK probes include retired tables and are reported separately; only actual observed parent operations determine whether a scan is reachable.', 'Potential scans are rejected conservatively. A recognized constant guard proves no business row access when the path reaches Halt without reading or writing a row.'],
    inventory: inventory.sites.map(site => ({ ...site, observed: covered.has(site.key), sourcePlanned: planned.has(site.key) })),
    uncovered,
    observations,
    sourcePlans,
    compilationOnlyPlans,
    sourcePlanFailures,
    queryShapes,
    testStatements,
    foreignKeys: foreignKeys.map(query => ({ ...query, status: 'schema-only-potential; actual parent writes checked in observations' })),
  }
}

export function markdownReport(report) {
  const { summary } = report
  const sections = [`# Backend DB query scan check`, `Outcome: ${report.outcome}`, `Test process exit: ${report.testExitCode}; capture files: ${report.captureFiles}.`, `Query sites: ${summary.querySites}; automatically covered: ${summary.automaticCoveredSites} (${summary.automaticCoveragePercent}%); observed: ${summary.observedSites}; source plans: ${summary.sourcePlannedSites}; uncovered: ${summary.uncoveredSites}. Bound statements: ${summary.boundStatements}; unattributed: ${summary.unattributedStatements}; test injections: ${summary.testInjectedStatements}; FK lookup plans: ${summary.foreignKeys}; hazards: ${summary.hazards}.`, '## Limits', ...report.limitations.map(line => `- ${line}`), '## Findings (unknown origins are unverified, not established product defects)']
  for (const query of [...report.observations, ...report.sourcePlans, ...report.compilationOnlyPlans].filter(query => query.error || query.scans.length || query.unscopedSearches?.length)) {
    const source = typeof query.source === 'string' ? query.source : `${query.source.file}:${query.source.line}`
    sections.push(`### ${source}`, `Classification: ${query.classification}`, `\`\`\`sql\n${query.sql}\n\`\`\``, `Bind shape: ${JSON.stringify(query.bindShape)}`, query.error ? `Compilation error: ${query.error}` : `Scans: ${JSON.stringify(query.scans)}; unscoped SEARCH: ${JSON.stringify(query.unscopedSearches ?? [])}`, `Plan: ${JSON.stringify(query.plan)}`)
  }
  sections.push('## Schema-only FK potential scans (not observed operations)', ...report.foreignKeys.filter(query => query.scans.length || query.unscopedSearches?.length || query.error).map(query => `- ${query.source}: ${JSON.stringify(query.scans)} ${query.error ?? ''}`))
  sections.push('## Unattributed observed statements', ...report.observations.filter(query => query.attribution === 'unknown').map(query => `- ${query.source.file}:${query.source.line}: ${query.sql}`))
  sections.push('## Proven dependency executions', ...report.observations.filter(query => query.dependencySource).map(query => {
    const { package: name, version, construction, execution } = query.dependencySource
    return `- ${name}@${version} ${construction.file}:${construction.line} → ${execution.file}:${execution.line} (${query.source.file}:${query.source.line}): ${query.sql}`
  }))
  sections.push('## Proven test injections (not product coverage)', ...report.testStatements.map(query => `- ${query.source.file}:${query.source.line} (${query.proof}): ${query.sql}`))
  sections.push('## Multi-shape source positions', ...report.queryShapes.map(shape => `- ${shape.site}: runtime ${shape.observed}; source ${shape.source}`))
  sections.push('## Direct compiler evidence', ...report.compilationOnlyPlans.map(query => `- ${query.source.file}:${query.source.line} (${query.classification}): ${query.sql}\n  Bind shape: ${JSON.stringify(query.bindShape)}\n  Binding cases: ${query.bindingCases}\n  Plan: ${JSON.stringify(query.plan)}`))
  sections.push('## Source compilation gaps', ...report.sourcePlanFailures.map(failure => `- ${failure.siteKey}: ${failure.reason}`))
  sections.push('## Uncovered source sites', ...report.uncovered.map(site => `- ${site.file}:${site.line} ${site.key} (${site.resolution}; ${site.instrumentation ?? 'construction'})`))
  return sections.join('\n\n') + '\n'
}
