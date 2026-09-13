import test from 'node:test'
import assert from 'node:assert/strict'
import { distribution, summarize } from '../src/report.mjs'

test('null observations are excluded from percentiles, not failures or denominators', () => {
  assert.deepEqual(distribution([null, 10, 20, NaN]), { n: 2, p50: 10, p95: 20, p99: 20, min: 10, max: 20 })
  const metadata = { config: { phases: [{ name: 'baseline' }], payloadBytes: [64] } }
  const report = summarize([{ requestId: 'r', phase: 'baseline', payloadBytes: 64, startedMs: 1, finishedMs: 1001, ackMs: null, error: 'timeout', receivers: [{ receiveMs: null, duplicates: 0, outcome: 'unresolved' }] }], metadata)
  assert.equal(report.groups[0].attempted, 1)
  assert.equal(report.groups[0].failed, 1)
  assert.equal(report.groups[0].unresolved, 1)
  assert.equal(report.groups[0].sendAckMs.p50, null)
  assert.equal(report.db.status, 'unavailable')
  assert.equal(report.db.executionCalls, null)
  assert.equal(report.db.knownRowsRead, null)
  assert.equal(report.db.requestsWithoutCompletion, 1)
})

test('DB phase/payload/API groups stay separate and duplicated telemetry is not double-counted', () => {
  const metadata = { config: { phases: [{ name: 'baseline' }, { name: 'delay' }], payloadBytes: [64] } }
  const samples = ['baseline', 'delay'].map((phase, i) => ({ requestId: `r${i}`, phase, payloadBytes: 64, startedMs: i * 1000, finishedMs: i * 1000 + 900, receivers: [], history: { requestId: `h${i}` } }))
  const event = { benchmark: 1, requestId: 'r0', kind: 'd1', operation: 1, method: 'raw', statements: 1, ok: true, wallMs: 3, sqlBytes: 12, parameterJsonBytes: 2, resultJsonBytes: 20, metadata: [{ rowsRead: null, rowsWritten: null, sqlDurationMs: null, internalAttempts: null }] }
  const report = summarize(samples, metadata, [event, event, { ...event, requestId: 'h1', metadata: [{ rowsRead: 3, rowsWritten: 0, sqlDurationMs: 1, internalAttempts: 1 }] }])
  assert.equal(report.db.duplicateTelemetryRecords, 1)
  assert.equal(report.db.executionCalls, 2)
  assert.equal(report.db.groups[0].send.executionCalls, 1)
  assert.equal(report.db.groups[0].history.executionCalls, null)
  assert.equal(report.db.groups[1].history.rowsRead.total, 3)
  assert.equal(report.db.rowsRead.coverage, .5)
  assert.equal(report.db.parameterJsonBytes.total, 4)
  assert.throws(() => summarize(samples, metadata, [event, { ...event, wallMs: 4 }]), /Conflicting telemetry/)
})

test('a fast 429 never improves successful ACK percentiles', () => {
  const metadata = { config: { phases: [{ name: 'baseline' }], payloadBytes: [64] } }
  const common = { phase: 'baseline', payloadBytes: 64, startedMs: 0, finishedMs: 1000, receivers: [] }
  const result = summarize([{ ...common, requestId: 'ok', messageId: 'm', ackMs: 100, error: null, status: 201 }, { ...common, requestId: 'limit', ackMs: 1, error: 'send-failed', status: 429 }], metadata)
  assert.equal(result.groups[0].sendAckMs.p50, 100)
  assert.equal(result.groups[0].failedHttpResponseMs.p50, 1)
  assert.equal(result.groups[0].failed, 1)
})


test('completed observed requests with no D1 execution report real zero, missing logs remain unknown', async () => {
  const { dbMetrics } = await import('../src/report.mjs')
  const zero = dbMetrics(['empty'], [{ kind: 'request-complete', requestId: 'empty', failedTasks: 0, d1Calls: 0 }])
  assert.equal(zero.status, 'observed-empty')
  assert.equal(zero.executionCalls, 0)
  assert.equal(zero.submittedStatements, 0)
  assert.equal(zero.rowsRead.total, 0)
  assert.equal(zero.sqlBytes.total, 0)
  const missing = dbMetrics(['empty', 'missing'], [{ kind: 'request-complete', requestId: 'empty', failedTasks: 0, d1Calls: 0 }])
  assert.equal(missing.executionCalls, null)
  assert.equal(missing.rowsRead.total, null)
  const lost = dbMetrics(['empty'], [{ kind: 'request-complete', requestId: 'empty', d1Calls: 1 }])
  assert.equal(lost.executionCalls, null)
  assert.equal(lost.missingD1Events, 1)
  const partial = dbMetrics(['partial'], [{ kind: 'request-complete', requestId: 'partial', d1Calls: 2 }, { kind: 'd1', requestId: 'partial', statements: 1, metadata: [{ rowsRead: 3, rowsWritten: 1 }], sqlBytes: 20 }])
  assert.equal(partial.rowsRead.total, 3)
  assert.equal(partial.rowsRead.coverage, null)
  assert.equal(partial.sqlBytes.coverage, null)
  assert.equal(partial.missingD1Events, 1)
})
