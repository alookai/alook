import { distribution, dbMetrics, deduplicateTelemetry } from './report.mjs'

const sum = values => values.reduce((a, b) => a + b, 0)
const requests = sample => sample.requestsAtCutoff
const frames = sample => sample.framesAtCutoff

export function browserSummary(samples, metadata, telemetry = []) {
  if (metadata.schemaVersion !== 2 || !metadata.case?.metrics || !metadata.workloads || !metadata.participants) throw new Error('Unsupported browser artifact schema; rebuild with the tool version recorded by that run')
  const deduplicated = deduplicateTelemetry(telemetry)
  telemetry = deduplicated.events
  const measured = samples.filter(sample => !sample.warmup), groups = []
  for (const phase of metadata.config.phases) for (const workload of metadata.workloads) {
    const selected = measured.filter(sample => sample.phase === phase.name && sample.workloadId === workload.id)
    if (!selected.length) continue
    const good = selected.filter(sample => !sample.error)
    const db = direct => dbMetrics(selected.flatMap(sample => requests(sample).filter(record => record.direct === direct && record.observedDB).map(record => record.id)), telemetry)
    groups.push({ phase: phase.name, workloadId: workload.id, workloadLabel: workload.label, attempted: selected.length, failed: selected.length - good.length,
      caseMetrics: Object.fromEntries(Object.entries(metadata.case.metrics).map(([name, definition]) => [name, distribution((definition.successOnly === false ? selected : good).map(sample => sample.result.metrics[name]))])),
      directAckMs: distribution(selected.flatMap(sample => requests(sample).filter(record => record.direct && record.status >= 200 && record.status < 300 && !record.failure && record.finishedMs !== null && sample.submitNodeMs !== null).map(record => record.finishedMs - sample.submitNodeMs))),
      failedHttpMs: distribution(selected.flatMap(sample => requests(sample).filter(record => record.direct && (record.status >= 400 || record.failure) && record.finishedMs !== null && sample.submitNodeMs !== null).map(record => record.finishedMs - sample.submitNodeMs))),
      socketCloses: sum(selected.flatMap(sample => sample.socketCloses)), collectorErrors: sum(selected.map(sample => sample.collectorErrors.length)),
      unfinishedRequests: sum(selected.map(sample => sample.unfinishedRequestsAtCutoff)),
      directRequestBodyBytes: distribution(selected.map(sample => sum(requests(sample).filter(record => record.direct).map(record => record.requestBodyBytes)))),
      directResponseBodyBytes: distribution(selected.flatMap(sample => requests(sample).filter(record => record.direct).map(record => record.responseBodyBytes))),
      windowHttpResponseBodyBytes: distribution(selected.map(sample => sum(requests(sample).filter(record => record.finishedMs !== null && record.finishedMs <= sample.cutoffMs).map(record => record.responseBodyBytes ?? 0)))),
      windowWsApplicationBytes: distribution(selected.map(sample => sum(frames(sample).map(frame => frame.bytes)))),
      pageTaskCpuMs: metadata.participants.map(({ role }) => distribution(selected.map(sample => sample.resources[role].taskCpuMs))),
      pageJsHeapDeltaBytes: metadata.participants.map(({ role }) => distribution(selected.map(sample => {
        const resource = sample.resources[role]
        return Number.isFinite(resource.jsHeapBeforeBytes) && Number.isFinite(resource.jsHeapAfterBytes) ? resource.jsHeapAfterBytes - resource.jsHeapBeforeBytes : null
      }))),
      db: { directRequests: db(true), otherWindowRequests: db(false) }, smallSampleWarning: selected.length < 100 ? 'Fewer than 100 attempts; tail percentiles exploratory.' : null })
  }
  return { ...metadata, duplicateTelemetryRecords: deduplicated.duplicateTelemetryRecords, groups,
    db: dbMetrics(measured.flatMap(sample => requests(sample).filter(record => record.observedDB).map(record => record.id)), telemetry),
    limits: ['DOM visibility and animation-frame callbacks do not prove physical screen paint.', 'HTTP bodies are decoded application bytes; WS excludes protocol framing.', 'Window HTTP/WS and page main-thread CPU include concurrent work and observer overhead; window does not prove background completion.', 'DB covers only instrumented web env.DB. Other services, server CPU/RSS and physical I/O remain unknown.'] }
}

const format = distribution => [distribution.p50, distribution.p95].map(value => value?.toFixed(2) ?? 'unknown').join('/')
export function browserMarkdown(report) {
  const definitions = Object.entries(report.case.metrics)
  const rows = report.groups.map(group => `| ${group.phase}/${group.workloadLabel} | ${group.attempted}/${group.failed} | ${definitions.map(([name]) => format(group.caseMetrics[name])).join(' | ')} | ${format(group.directAckMs)} |`).join('\n')
  const resource = report.groups.map(group => `| ${group.phase}/${group.workloadLabel} | ${report.participants.map(({ role, name }) => `${name}: ${format(group.pageTaskCpuMs[role])}`).join('; ')} | ${format(group.directRequestBodyBytes)} | ${format(group.directResponseBodyBytes)} | ${format(group.windowHttpResponseBodyBytes)} | ${format(group.windowWsApplicationBytes)} | ${group.unfinishedRequests}/${group.collectorErrors}/${group.socketCloses} |`).join('\n')
  const db = report.groups.flatMap(group => Object.entries(group.db).map(([scope, value]) => `| ${group.phase}/${group.workloadLabel}/${scope} | ${value.executionCalls ?? 'unknown'} | ${value.submittedStatements ?? 'unknown'} | ${value.rowsRead.total ?? 'unknown'} (${value.rowsRead.coverage ?? 'unknown'}) | ${value.rowsWritten.total ?? 'unknown'} (${value.rowsWritten.coverage ?? 'unknown'}) | ${value.completedRequests}/${value.expectedRequests} |`)).join('\n')
  return `# Real browser operation benchmark\n\nCase ${report.case.id} v${report.case.version}; target ${report.config.targetVersion}; ${report.config.networkMode}. ${report.participants.length} real browser pages. Fixture: ${JSON.stringify(report.fixture)}.\n\nDistributions are p50/p95. Failed attempts stay in denominator; small-sample tails exploratory.\n\n| Phase/workload | Attempts/failed | ${definitions.map(([, definition]) => `${definition.label} (${definition.unit})`).join(' | ')} | Direct ACK ms |\n|---|---:|${definitions.map(() => '---:|').join('')}---:|\n${rows}\n\n| Phase/workload | Page main-thread CPU ms | Direct request B | Direct response B | Window HTTP response B | Window WS application B | Unclosed/collector errors/socket closes |\n|---|---|---:|---:|---:|---:|---:|\n${resource}\n\nD1 events known missing: ${report.db.missingD1Events ?? 'unknown (no complete execution counters)'}. Known loss blocks comparison.\n\nDB known totals, coverage fraction; unknown rows are not zero. Direct requests and other window requests are separate.\n\n| Scope | Calls | Submitted statements | Known rows read (coverage) | Known rows written (coverage) | Web request completion |\n|---|---:|---:|---:|---:|---:|\n${db}\n\n${report.limits.map(line => '- ' + line).join('\n')}\n\noperations.jsonl retains frozen cutoff observations, later HTTP completion, case-specific raw diagnostics, page clocks, trusted submit event, resource windows and injection waits.\n`
}
