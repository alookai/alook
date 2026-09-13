const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

export function compareReports(base, head) {
  if (!base.finishedAt || !head.finishedAt) throw new Error('Incomplete runs cannot be compared')
  if ([base, head].some(report => report.db?.missingD1Events > 0)) throw new Error('Incomplete D1 logs: declared execution events are missing; cost comparison refused')
  const contract = report => ({ kind: report.kind, config: Object.fromEntries(Object.entries(report.config).filter(([key]) => !['targetVersion', 'baseUrl'].includes(key))), runner: report.runner, fixture: Object.fromEntries(Object.entries(report.fixture).filter(([key]) => !['serverId', 'channelId'].includes(key))) })
  if (base.kind !== 'browser-user-operation' || canonical(contract(base)) !== canonical(contract(head))) throw new Error('Incompatible measurement modes, workload, fixture or runner environment')
  const compare = (a, b) => ({ base: a, head: b, delta: Number.isFinite(a) && Number.isFinite(b) ? b - a : null, percent: Number.isFinite(a) && Number.isFinite(b) && a !== 0 ? 100 * (b - a) / a : null })
  const groups = head.groups.map(h => {
    const b = base.groups.find(g => g.phase === h.phase && g.payloadBytes === h.payloadBytes)
    if (!b) throw new Error('Incompatible scenario groups')
    const metrics = {}
    for (const key of ['senderVisibleMs', 'receiverVisibleMs', 'senderReconciledMs', 'sendAckMs', 'requestBodyBytes', 'sendResponseBodyBytes', 'windowHttpResponseBodyBytes', 'windowWsApplicationBytes']) {
      for (const percentile of ['p50', 'p95']) metrics[`${key}.${percentile}`] = compare(b[key][percentile], h[key][percentile])
    }
    for (const role of [0, 1]) metrics[`pageTaskCpuMs.${role}.p50`] = compare(b.pageTaskCpuMs[role].p50, h.pageTaskCpuMs[role].p50)
    for (const scope of ['directSend', 'otherWindowRequests']) for (const key of ['executionCalls', 'submittedStatements']) metrics[`db.${scope}.${key}`] = compare(b.db[scope][key], h.db[scope][key])
    for (const scope of ['directSend', 'otherWindowRequests']) for (const key of ['rowsRead', 'rowsWritten', 'sqlBytes', 'parameterJsonBytes', 'resultJsonBytes']) {
      const a = b.db[scope][key], z = h.db[scope][key]
      metrics[`db.${scope}.${key}.knownTotal`] = { ...compare(a.total, z.total), baseCoverage: a.coverage, headCoverage: z.coverage,
        attribution: a.coverage === z.coverage ? (a.coverage === 1 ? 'observed scope total' : 'known partial only') : 'coverage differs; cannot infer overall cost change' }
      metrics[`db.${scope}.${key}.coverage`] = compare(a.coverage, z.coverage)
    }
    return { phase: h.phase, payloadBytes: h.payloadBytes, attempted: compare(b.attempted, h.attempted), failed: compare(b.failed, h.failed), metrics }
  })
  return { baseVersion: base.config.targetVersion, headVersion: head.config.targetVersion, sameVersionControl: base.config.targetVersion === head.config.targetVersion, groups }
}

export function comparisonMarkdown(report) {
  return `# Browser benchmark comparison\n\n${report.baseVersion} → ${report.headVersion}${report.sameVersionControl ? '; same-version repeatability control, not feature improvement evidence' : ''}. Negative latency/byte deltas mean less observed cost. Unknown remains unknown.\n\n| Phase/content B | Metric | Base | Head | Delta | Change % | Coverage/interpretation |\n|---|---|---:|---:|---:|---:|---|\n${report.groups.flatMap(g => Object.entries({ attempted: g.attempted, failed: g.failed, ...g.metrics }).map(([key, values]) => `| ${g.phase}/${g.payloadBytes} | ${key} | ${['base', 'head', 'delta', 'percent'].map(k => values[k]?.toFixed(2) ?? 'unknown').join(' | ')} | ${values.attribution ? `${values.baseCoverage ?? 'unknown'} → ${values.headCoverage ?? 'unknown'}; ${values.attribution}` : ''} |`)).join('\n')}\n`
}
