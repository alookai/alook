export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null
  return { n: sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), min: sorted[0] ?? null, max: sorted.at(-1) ?? null }
}

export function summarize(samples, metadata, telemetry = []) {
  const measured = samples.filter(s => !s.warmup)
  const groups = []
  for (const phase of metadata.config.phases) {
    for (const payloadBytes of metadata.config.payloadBytes) {
      const selected = measured.filter(s => s.phase === phase.name && s.payloadBytes === payloadBytes)
      if (!selected.length) continue
      const received = selected.flatMap(s => s.receivers)
      const elapsedMs = Math.max(...selected.map(s => s.finishedMs)) - Math.min(...selected.map(s => s.startedMs))
      groups.push({ phase: phase.name, payloadBytes, attempted: selected.length,
        acknowledged: selected.filter(s => s.messageId && s.status >= 200 && s.status < 300 && !s.parseError && !s.error).length,
        failed: selected.filter(s => s.error).length, expectedDeliveries: received.length,
        delivered: received.filter(r => r.receiveMs !== null).length,
        timedOut: received.filter(r => r.receiveMs === null && r.outcome !== 'unresolved').length,
        unresolved: received.filter(r => r.outcome === 'unresolved').length, late: received.reduce((sum, r) => sum + (r.late ?? 0), 0),
        duplicates: received.reduce((sum, r) => sum + r.duplicates, 0),
        sendAckMs: distribution(selected.filter(s => !s.error && s.messageId).map(s => s.ackMs)),
        failedHttpResponseMs: distribution(selected.filter(s => s.error).map(s => s.ackMs)), receiveMs: distribution(received.map(r => r.receiveMs)),
        historyMs: distribution(selected.filter(s => s.history?.ok).map(s => s.history.wallMs)),
        historyFailed: selected.filter(s => s.history && !s.history.ok).length,
        workflowThroughputPerSecond: selected.length / (elapsedMs / 1000), elapsedMs,
        requestBodyBytes: distribution(selected.map(s => s.requestBodyBytes)),
        responseBodyBytes: distribution(selected.map(s => s.responseBodyBytes)),
        wsApplicationBytes: distribution(received.map(r => r.frameBytes)),
        smallSampleWarning: selected.length < 1000 ? 'p99 is exploratory; fewer than 1000 attempts' : null })
    }
  }
  const { events, duplicateTelemetryRecords } = deduplicateTelemetry(telemetry)
  const requestIds = selected => selected.flatMap(s => [s.requestId, ...(s.history ? [s.history.requestId] : [])])
  const db = { ...dbMetrics(requestIds(measured), events), duplicateTelemetryRecords, groups: [] }
  for (const group of groups) {
    const selected = measured.filter(s => s.phase === group.phase && s.payloadBytes === group.payloadBytes)
    db.groups.push({ phase: group.phase, payloadBytes: group.payloadBytes,
      send: dbMetrics(selected.map(s => s.requestId), events),
      history: dbMetrics(selected.flatMap(s => s.history ? [s.history.requestId] : []), events) })
  }
  return { ...metadata, warning: 'DB coverage is incomplete. UI render and physical/network wire bytes are not measured.',
    percentileMethod: 'nearest rank over available observations; missing deliveries remain in failure counts', db, groups }
}

export function markdown(report) {
  const latency = report.groups.map(g => `| ${g.phase} | ${g.payloadBytes} | ${g.attempted} | ${g.failed} | ${format(g.sendAckMs)} | ${format(g.receiveMs)} | ${g.timedOut}/${g.unresolved} | ${g.historyMs.p95?.toFixed(2) ?? 'unknown'} |`).join('\n')
  const bytes = report.groups.map(g => `| ${g.phase} | ${g.payloadBytes} | ${format(g.requestBodyBytes)} | ${format(g.responseBodyBytes)} | ${format(g.wsApplicationBytes)} |`).join('\n')
  const cost = report.db.groups.flatMap(g => ['send', 'history'].map(kind => {
    const d = g[kind]
    return `| ${g.phase}/${g.payloadBytes}/${kind} | ${d.executionCalls ?? 'unknown'}/${d.submittedStatements ?? 'unknown'} | ${covered(d.rowsRead)} | ${covered(d.rowsWritten)} | ${d.sqlBytes.total ?? 'unknown'}/${d.parameterJsonBytes.total ?? 'unknown'}/${d.resultJsonBytes.total ?? 'unknown'} | ${d.completedRequests}/${d.expectedRequests} |`
  })).join('\n')
  return `# Message benchmark\n\n${report.warning}\n\nTarget: ${report.config.baseUrl}; version: ${report.config.targetVersion}. Observer requested: ${report.config.observeDB}.\nServer members: ${report.fixture.serverMembers}; visible channel members: ${report.fixture.visibleMembers}; connected receiving accounts: ${report.fixture.measuredReceivers}.\n\n| Phase | Content B | Attempts | Send failures | ACK p50/p95/p99 ms | WS p50/p95/p99 ms | Missing/unresolved WS | History p95 ms |\n|---|---:|---:|---:|---|---|---|---:|\n${latency}\n\nApplication payload bytes (p50/p95/p99):\n\n| Phase | Content B | HTTP request B | HTTP response B | WS application B |\n|---|---:|---|---|---|\n${bytes}\n\nDB observations (known row totals with metadata coverage; these are incomplete costs):\n\n| Phase/content B/API | Calls/submitted statements | Known rows read (coverage) | Known rows written (coverage) | Logical SQL/params/result B totals | Web completions |\n|---|---:|---|---|---|---|\n${cost}\n\nDB status: ${report.db.status}; completed observed web requests: ${report.db.completedRequests}/${report.db.expectedRequests}. ${report.db.coverage}.\n\nACK percentiles include successful sends only; failed HTTP response timings remain separate in JSON. HTTP bytes are decoded response/application request bodies. WS bytes exclude protocol framing. DB byte fields are logical JSON encodings, not physical I/O. Throughput is closed-loop workflow attempts per second, including WS wait, history reads and configured pacing; injected runs have a lower offered load. Warmups excluded. Each group below 1000 attempts has an exploratory p99. See summary.json and raw JSONL for per-receiver outcomes, duplicate/late frames, injection waits, exact configuration, and DB byte/duration distributions.\n`
}

function covered(metric) { return `${metric.total ?? 'unknown'} (${metric.coverage === null ? 'unknown' : (100 * metric.coverage).toFixed(1) + '%'})` }

function format(d) { return [d.p50, d.p95, d.p99].map(n => n?.toFixed(2) ?? 'unknown').join('/') }

export function dbMetrics(ids, events) {
  const expected = new Set(ids)
  const selected = events.filter(e => expected.has(e.requestId))
  const calls = selected.filter(e => e.kind === 'd1')
  const completions = selected.filter(e => e.kind === 'request-complete')
  const completed = new Set(completions.map(e => e.requestId))
  const missingD1Events = completions.length && completions.every(event => Number.isInteger(event.d1Calls)) ? completions.reduce((sum, event) => sum + Math.max(0, event.d1Calls - calls.filter(call => call.requestId === event.requestId).length), 0) : null
  const observedEmpty = expected.size > 0 && completed.size === expected.size && calls.length === 0 && completions.every(event => event.d1Calls === 0)
  const metadata = calls.flatMap(c => c.metadata)
  const statementCount = calls.some(c => c.statements === null) ? null : calls.reduce((sum, c) => sum + c.statements, 0)
  const metric = (values, expectedCount) => {
    const known = values.filter(Number.isFinite)
    return { total: known.length ? known.reduce((a, b) => a + b, 0) : observedEmpty ? 0 : null,
      distribution: distribution(known), observed: known.length, expected: missingD1Events > 0 ? null : expectedCount,
      coverage: missingD1Events > 0 ? null : expectedCount > 0 ? known.length / expectedCount : null }
  }
  const rowsRead = metric(metadata.map(m => m.rowsRead), statementCount)
  const rowsWritten = metric(metadata.map(m => m.rowsWritten), statementCount)
  const sqlDuration = metric(metadata.map(m => m.sqlDurationMs), statementCount)
  return {
    coverage: 'web env.DB invocation only; WS DO and queue consumers not observed; raw/first metadata unavailable',
    status: calls.length ? 'partial' : observedEmpty ? 'observed-empty' : 'unavailable', expectedRequests: expected.size, completedRequests: completed.size,
    missingD1Events,
    requestsWithoutCompletion: [...expected].filter(id => !completed.has(id)).length,
    executionCalls: calls.length || (observedEmpty ? 0 : null), submittedStatements: calls.length || observedEmpty ? statementCount : null,
    failedCalls: calls.length || observedEmpty ? calls.filter(c => !c.ok).length : null,
    failedBackgroundTasks: completions.reduce((sum, c) => sum + c.failedTasks, 0),
    callWallMs: distribution(calls.map(c => c.wallMs)),
    rowsRead, rowsWritten, sqlDuration, knownRowsRead: rowsRead.total, knownRowsWritten: rowsWritten.total, knownSqlDurationMs: sqlDuration.total,
    sqlBytes: metric(calls.map(c => c.sqlBytes), calls.length), parameterJsonBytes: metric(calls.map(c => c.parameterJsonBytes), calls.length),
    resultJsonBytes: metric(calls.map(c => c.resultJsonBytes), calls.length),
    internalAttempts: metric(metadata.map(m => m.internalAttempts), statementCount),
    backgroundCallsStarted: calls.filter(c => c.startedAfterResponse).length,
    callsCrossingResponse: calls.filter(c => !c.startedAfterResponse && c.completedAfterResponse).length,
  }
}

export function deduplicateTelemetry(telemetry) {
  const deduplicated = new Map()
  let duplicateTelemetryRecords = 0
  for (const event of telemetry.filter(e => e.benchmark === 1)) {
    const key = `${event.requestId}:${event.kind}:${event.operation ?? ''}`
    if (deduplicated.has(key)) {
      if (JSON.stringify(deduplicated.get(key)) !== JSON.stringify(event)) throw new Error('Conflicting telemetry record')
      duplicateTelemetryRecords++
    } else deduplicated.set(key, event)
  }
  const events = [...deduplicated.values()]
  return { events, duplicateTelemetryRecords }
}
