import test from 'node:test'
import assert from 'node:assert/strict'
import { browserSummary } from '../src/browser-report.mjs'
import { compareReports } from '../src/compare.mjs'

const metadata = { kind: 'browser-user-operation', finishedAt: '2026-09-13T00:00:00Z', config: { targetVersion: 'A', observeDB: false, phases: [{ name: 'baseline', delayMs: 0 }], payloadBytes: [64] }, fixture: { visibleMembers: 100 }, runner: { browser: 'control' } }
const sample = { id: 'operation', phase: 'baseline', payloadBytes: 64, clickMs: 10, cutoffMs: 100, error: null, unfinishedRequestsAtCutoff: 1,
  dom: [{ visibleMs: 2, nextFrameMs: 3, canonicalMs: 12 }, { visibleMs: 15, nextFrameMs: 16, canonicalMs: 15 }],
  requestsAtCutoff: [{ id: 'request', isSend: true, observedDB: true, requestBodyBytes: 64, responseBodyBytes: null, status: 200, finishedMs: null }],
  requests: [{ id: 'request', isSend: true, observedDB: true, requestBodyBytes: 64, responseBodyBytes: 400, status: 200, finishedMs: 150 }], framesAtCutoff: [],
  resources: [{ taskCpuMs: 5, jsHeapBeforeBytes: 100, jsHeapAfterBytes: 110 }, { taskCpuMs: null, jsHeapBeforeBytes: null, jsHeapAfterBytes: null }] }

test('cutoff body remains unknown and unsuccessful attempts do not improve visible percentiles', () => {
  const report = browserSummary([sample, { ...sample, error: 'timeout', dom: sample.dom.map(d => ({ ...d, visibleMs: 1 })) }], metadata)
  assert.equal(report.groups[0].attempted, 2)
  assert.equal(report.groups[0].failed, 1)
  assert.equal(report.groups[0].senderVisibleMs.p50, 2)
  assert.equal(report.groups[0].sendResponseBodyBytes.n, 0)
  assert.equal(report.groups[0].sendAckMs.n, 0)
  assert.equal(report.groups[0].pageTaskCpuMs[1].p50, null)
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
  assert.equal(compareReports(a, b).groups[0].metrics['db.directSend.rowsRead.knownTotal'].delta, null)
  b.db.missingD1Events = 1
  assert.throws(() => compareReports(a, b), /Incomplete D1 logs/)
  b.db.missingD1Events = null
  b.config.observeDB = true
  assert.throws(() => compareReports(a, b), /Incompatible/)
  b.config.observeDB = false
  b.config.payloadBytes = [1024]
  assert.throws(() => compareReports(a, b), /Incompatible/)
})
