import { distribution, dbMetrics, deduplicateTelemetry } from './report.mjs'

const sum = values => values.reduce((a, b) => a + b, 0)
const requests = sample => sample.requestsAtCutoff ?? sample.requests
const frames = sample => sample.framesAtCutoff ?? sample.frames

export function browserSummary(samples, metadata, telemetry = []) {
  const deduplicated = deduplicateTelemetry(telemetry)
  telemetry = deduplicated.events
  const measured = samples.filter(sample => !sample.warmup)
  const groups = []
  for (const phase of metadata.config.phases) for (const payloadBytes of metadata.config.payloadBytes) {
    const selected = measured.filter(sample => sample.phase === phase.name && sample.payloadBytes === payloadBytes)
    if (!selected.length) continue
    const good = selected.filter(sample => !sample.error)
    const db = direct => dbMetrics(selected.flatMap(sample => requests(sample).filter(r => !!r.isSend === direct && (r.observedDB ?? metadata.config.observeDB)).map(r => r.id)), telemetry)
    groups.push({ phase: phase.name, payloadBytes, attempted: selected.length, failed: selected.length - good.length,
      senderVisibleMs: distribution(good.map(sample => sample.dom[0].visibleMs)),
      receiverVisibleMs: distribution(good.map(sample => sample.dom[1].visibleMs)),
      senderNextFrameMs: distribution(good.map(sample => sample.dom[0].nextFrameMs)),
      receiverNextFrameMs: distribution(good.map(sample => sample.dom[1].nextFrameMs)),
      senderReconciledMs: distribution(good.map(sample => sample.dom[0].canonicalMs)),
      sendAckMs: distribution(selected.flatMap(sample => requests(sample).filter(r => r.isSend && r.status >= 200 && r.status < 300 && !r.failure && r.finishedMs !== null).map(r => r.finishedMs - sample.clickMs))),
      failedHttpMs: distribution(selected.flatMap(sample => requests(sample).filter(r => r.isSend && (r.status >= 400 || r.failure) && r.finishedMs !== null).map(r => r.finishedMs - sample.clickMs))),
      duplicateMessageFrames: sum(selected.map(sample => sample.duplicateMessageFrames ?? 0)),
      disconnectedPages: sum(selected.map(sample => (sample.wsDisconnected ?? []).filter(Boolean).length)),
      unfinishedRequests: sum(selected.map(sample => sample.unfinishedRequestsAtCutoff)),
      requestBodyBytes: distribution(selected.map(sample => sum(requests(sample).filter(r => r.isSend).map(r => r.requestBodyBytes)))),
      sendResponseBodyBytes: distribution(selected.flatMap(sample => requests(sample).filter(r => r.isSend).map(r => r.responseBodyBytes))),
      windowHttpResponseBodyBytes: distribution(selected.map(sample => sum(requests(sample).filter(r => r.finishedMs !== null && r.finishedMs <= sample.cutoffMs).map(r => r.responseBodyBytes ?? 0)))),
      windowWsApplicationBytes: distribution(selected.map(sample => sum(frames(sample).map(frame => frame.bytes)))),
      pageTaskCpuMs: [0, 1].map(role => distribution(selected.map(sample => sample.resources[role].taskCpuMs))),
      pageJsHeapDeltaBytes: [0, 1].map(role => distribution(selected.map(sample => {
        const resource = sample.resources[role]
        return Number.isFinite(resource.jsHeapBeforeBytes) && Number.isFinite(resource.jsHeapAfterBytes) ? resource.jsHeapAfterBytes - resource.jsHeapBeforeBytes : null
      }))),
      db: { directSend: db(true), otherWindowRequests: db(false) },
      smallSampleWarning: selected.length < 100 ? 'Fewer than 100 attempts; tail percentiles exploratory.' : null })
  }
  return { ...metadata, duplicateTelemetryRecords: deduplicated.duplicateTelemetryRecords, groups, db: dbMetrics(measured.flatMap(sample => requests(sample).filter(r => r.observedDB ?? metadata.config.observeDB).map(r => r.id)), telemetry),
    limits: ['DOM visibility and animation-frame callbacks do not prove physical screen paint.', 'HTTP bodies are decoded application bytes; WS excludes protocol framing.', 'Window HTTP/WS and page main-thread CPU include concurrent work and observer overhead; window does not prove background completion.', 'DB covers only instrumented web env.DB. WS DO, queue, server CPU/RSS and physical I/O remain unknown.'] }
}

const format = d => [d.p50, d.p95].map(n => n?.toFixed(2) ?? 'unknown').join('/')
export function browserMarkdown(report) {
  const rows = report.groups.map(g => `| ${g.phase}/${g.payloadBytes} | ${g.attempted}/${g.failed} | ${format(g.senderVisibleMs)} | ${format(g.receiverVisibleMs)} | ${format(g.senderReconciledMs)} | ${format(g.sendAckMs)} |`).join('\n')
  const resource = report.groups.map(g => `| ${g.phase}/${g.payloadBytes} | ${format(g.pageTaskCpuMs[0])}; ${format(g.pageTaskCpuMs[1])} | ${format(g.requestBodyBytes)} | ${format(g.sendResponseBodyBytes)} | ${format(g.windowHttpResponseBodyBytes)} | ${format(g.windowWsApplicationBytes)} | ${g.unfinishedRequests} |`).join('\n')
  const db = report.groups.flatMap(g => Object.entries(g.db).map(([scope, d]) => `| ${g.phase}/${g.payloadBytes}/${scope} | ${d.executionCalls ?? 'unknown'} | ${d.submittedStatements ?? 'unknown'} | ${d.rowsRead.total ?? 'unknown'} (${d.rowsRead.coverage ?? 'unknown'}) | ${d.rowsWritten.total ?? 'unknown'} (${d.rowsWritten.coverage ?? 'unknown'}) | ${d.completedRequests}/${d.expectedRequests} |`)).join('\n')
  return `# Real browser operation benchmark\n\nTarget ${report.config.targetVersion}; ${report.config.networkMode}. Two real user pages; ${report.fixture.visibleMembers} visible channel members.\n\nAll distributions p50/p95; milliseconds unless bytes indicated. Failed attempts stay in denominator. Small-sample tails are exploratory.\n\n| Phase/content B | Attempts/failed | Sender visible | Receiver visible | Sender reconciled (diagnostic) | Send ACK |\n|---|---:|---:|---:|---:|---:|\n${rows}\n\n| Phase/content B | Main-thread CPU sender/receiver ms | Send request B | Send response B | Window HTTP response B | Window WS application B | Unclosed requests |\n|---|---:|---:|---:|---:|---:|---:|\n${resource}\n\nD1 events known missing: ${report.db.missingD1Events ?? 'unknown (no complete execution counters)'}. Known loss blocks comparison.\n\nDB known totals; coverage is a fraction, unknown rows are not zero. Direct sends and other window requests are separate.\n\n| Scope | Calls | Submitted statements | Known rows read (coverage) | Known rows written (coverage) | Web request completion |\n|---|---:|---:|---:|---:|---:|\n${db}\n\n${report.limits.map(line => '- ' + line).join('\n')}\n\nSee operations.jsonl for frozen cutoff observations and separately recorded later HTTP completion, page clocks, trusted submit event, IDs, resource windows and exact injection waits. JS heap changes and next-frame diagnostics are in summary.json.\n`
}
