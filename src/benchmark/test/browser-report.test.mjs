import test from 'node:test'
import assert from 'node:assert/strict'
import { browserSummary } from '../src/browser-report.mjs'
import { compareReports } from '../src/compare.mjs'

const metadata = { kind: 'browser-user-operation', schemaVersion: 2, finishedAt: '2026-09-13T00:00:00Z', case: { id: 'custom', version: 1, metrics: { customVisibleMs: { label: 'Custom visible', unit: 'ms', successOnly: true } } }, workloads: [{ id: 'custom-work', label: 'Custom work', params: { size: 64 } }], participants: [{ role: 0, name: 'page' }], config: { targetVersion: 'A', observeDB: false, phases: [{ name: 'baseline', delayMs: 0 }] }, fixture: {}, runner: { browser: 'control' } }
const sample = { id: 'operation', phase: 'baseline', workloadId: 'custom-work', submitNodeMs: 10, cutoffMs: 100, error: null, unfinishedRequestsAtCutoff: 1,
  result: { metrics: { customVisibleMs: 2 } }, socketCloses: [0], collectorErrors: [],
  requestsAtCutoff: [{ id: 'request', direct: true, observedDB: true, requestBodyBytes: 64, responseBodyBytes: null, status: 200, finishedMs: null }],
  requests: [{ id: 'request', direct: true, observedDB: true, requestBodyBytes: 64, responseBodyBytes: 400, status: 200, finishedMs: 150 }], framesAtCutoff: [],
  resources: [{ taskCpuMs: null, jsHeapBeforeBytes: null, jsHeapAfterBytes: null }] }

test('cutoff body remains unknown and unsuccessful attempts do not improve visible percentiles', () => {
  const report = browserSummary([sample, { ...sample, error: 'timeout', result: { metrics: { customVisibleMs: 1 } } }], metadata)
  assert.equal(report.groups[0].attempted, 2)
  assert.equal(report.groups[0].failed, 1)
  assert.equal(report.groups[0].caseMetrics.customVisibleMs.p50, 2)
  assert.equal(report.groups[0].directResponseBodyBytes.n, 0)
  assert.equal(report.groups[0].directAckMs.n, 0)
  assert.equal(report.groups[0].pageTaskCpuMs[0].p50, null)
})

test('browser telemetry deduplicates and rejects conflicting observations', () => {
  const event = { benchmark: 1, requestId: 'request', kind: 'd1', operation: 1, method: 'run', statements: 1, ok: true, metadata: [{ rowsRead: 1, rowsWritten: 1 }], sqlBytes: 20, parameterJsonBytes: 2, resultJsonBytes: 30 }
  const report = browserSummary([sample], metadata, [event, event])
  assert.equal(report.db.executionCalls, 1)
  assert.equal(report.duplicateTelemetryRecords, 1)
  assert.throws(() => browserSummary([sample], metadata, [event, { ...event, statements: 2 }]), /Conflicting/)
})

test('comparison accepts A/A, refuses observation/workload mismatch, and preserves unknown costs', () => {
  const a = browserSummary([sample], metadata)
  const b = structuredClone(a)
  assert.equal(compareReports(a, b).sameVersionControl, true)
  assert.equal(compareReports(a, b).groups[0].metrics['db.directRequests.rowsRead.knownTotal'].delta, null)
  b.db.missingD1Events = 1
  assert.throws(() => compareReports(a, b), /Incomplete D1 logs/)
  b.db.missingD1Events = null
  b.config.observeDB = true
  assert.throws(() => compareReports(a, b), /Incompatible/)
  b.config.observeDB = false
  b.workloads[0].params.size = 1024
  assert.throws(() => compareReports(a, b), /Incompatible/)
})

test('case identity, version and metric units form a comparison contract', () => {
  const a = browserSummary([sample], metadata)
  for (const change of [b => b.case.id = 'different', b => b.case.version++, b => b.case.metrics.customVisibleMs.unit = 'seconds']) {
    const b = structuredClone(a); change(b)
    assert.throws(() => compareReports(a, b), /Incompatible/)
  }
  assert.throws(() => browserSummary([sample], { ...metadata, schemaVersion: 1 }), /Unsupported/)
})
