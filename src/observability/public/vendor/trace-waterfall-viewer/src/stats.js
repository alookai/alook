// Aggregate statistics derived from the trace model.

import { unionLength } from './model.js';

/**
 * Per-service rollup: span count, wall-clock time occupied, self time and errors.
 * "Total time" is the union of that service's span intervals, so overlapping
 * spans from the same service are not counted twice.
 */
export function serviceSummary(trace) {
  const byService = new Map();
  for (const span of trace.spans) {
    let row = byService.get(span.service);
    if (!row) {
      row = {
        service: span.service,
        spanCount: 0,
        totalTime: 0,
        selfTime: 0,
        errorCount: 0,
        maxDuration: 0,
        intervals: [],
      };
      byService.set(span.service, row);
    }
    row.spanCount += 1;
    row.selfTime += span.selfTime;
    row.maxDuration = Math.max(row.maxDuration, span.duration);
    if (span.statusCode === 'error') row.errorCount += 1;
    row.intervals.push([span.start, span.start + span.duration]);
  }
  const rows = [...byService.values()].map((row) => {
    row.totalTime = unionLength(row.intervals);
    delete row.intervals;
    return row;
  });
  rows.sort((a, b) => b.selfTime - a.selfTime || a.service.localeCompare(b.service));
  return rows;
}

/** Headline latency numbers plus the slowest spans by self time. */
export function traceStats(trace, criticalPath, topN = 10) {
  const errorSpans = trace.spans.filter((s) => s.statusCode === 'error');
  const maxDepth = trace.spans.reduce((m, s) => Math.max(m, s.depth), 0);
  const slowest = [...trace.spans]
    .sort((a, b) => b.selfTime - a.selfTime || b.duration - a.duration)
    .slice(0, topN);
  return {
    duration: trace.duration,
    spanCount: trace.spans.length,
    serviceCount: trace.services.length,
    depth: maxDepth + 1,
    rootCount: trace.roots.length,
    orphanCount: trace.orphans.length,
    errorCount: errorSpans.length,
    criticalPathTotal: criticalPath ? criticalPath.total : 0,
    criticalPathSpanCount: criticalPath ? criticalPath.uids.size : 0,
    slowest,
  };
}

/** Nanoseconds to a compact human string. */
export function formatDuration(ns) {
  if (!Number.isFinite(ns)) return '—';
  const abs = Math.abs(ns);
  if (abs < 1000) return `${round(ns, 0)}ns`;
  if (abs < 1e6) return `${round(ns / 1e3, 2)}µs`;
  if (abs < 1e9) return `${round(ns / 1e6, 2)}ms`;
  if (abs < 60e9) return `${round(ns / 1e9, 3)}s`;
  const minutes = Math.floor(ns / 60e9);
  const seconds = (ns - minutes * 60e9) / 1e9;
  return `${minutes}m${round(seconds, 1)}s`;
}

function round(value, digits) {
  const s = value.toFixed(digits);
  return digits === 0 ? s : s.replace(/\.?0+$/, '');
}

export function formatPercent(part, whole) {
  if (!whole) return '0%';
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
}
