// Jaeger JSON parser.
//
// Handles the shape returned by the Jaeger query API (`/api/traces/<id>`) and
// by the "Download JSON" button in the Jaeger UI:
//
//   { data: [ { traceID, spans: [...], processes: { p1: { serviceName, tags } } } ] }
//
// Timestamps are microseconds since epoch; durations are microseconds.
// Parenthood is expressed through `references` with refType CHILD_OF.

import { ParseError, errorFromAttributes, normalizeKind } from './common.js';

const MICROS = 1000n;

function tagsToObject(tags) {
  const out = {};
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    if (!t || typeof t.key !== 'string') continue;
    out[t.key] = coerceTagValue(t);
  }
  return out;
}

function coerceTagValue(t) {
  const v = t.value;
  switch (t.type) {
    case 'bool':
      return v === true || v === 'true';
    case 'int64':
    case 'float64': {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    default:
      return v;
  }
}

function tracesOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.data)) return doc.data;
  if (doc && Array.isArray(doc.spans)) return [doc];
  return null;
}

export function looksLikeJaeger(doc) {
  const traces = tracesOf(doc);
  if (!traces || traces.length === 0) return false;
  return traces.some(
    (t) =>
      t &&
      typeof t === 'object' &&
      Array.isArray(t.spans) &&
      t.spans.some((s) => s && (s.operationName !== undefined || s.spanID !== undefined)),
  );
}

/** @returns {object[]} raw normalized spans */
export function parseJaeger(doc) {
  const traces = tracesOf(doc);
  if (!traces) throw new ParseError('Jaeger document has no `data` array');
  const spans = [];
  for (const trace of traces) {
    if (!trace || !Array.isArray(trace.spans)) continue;
    const processes = trace.processes || {};
    for (const s of trace.spans) {
      if (!s || typeof s !== 'object') continue;
      spans.push(normalizeSpan(s, processes, trace));
    }
  }
  return spans;
}

function normalizeSpan(s, processes, trace) {
  const proc = processes[s.processID] || s.process || {};
  const service = typeof proc.serviceName === 'string' ? proc.serviceName : 'unknown_service';
  const resourceAttributes = tagsToObject(proc.tags);
  const attributes = tagsToObject(s.tags);

  let parentSpanId = '';
  const refs = Array.isArray(s.references) ? s.references : [];
  const childOf = refs.find((r) => r && r.refType === 'CHILD_OF');
  if (childOf) parentSpanId = String(childOf.spanID || '').toLowerCase();
  else if (s.parentSpanID) parentSpanId = String(s.parentSpanID).toLowerCase();

  const links = refs
    .filter((r) => r && r !== childOf)
    .map((r) => ({
      traceId: String(r.traceID || '').toLowerCase(),
      spanId: String(r.spanID || '').toLowerCase(),
      attributes: { 'jaeger.ref_type': r.refType },
    }));

  const startAbs = BigInt(Math.round(Number(s.startTime) || 0)) * MICROS;
  const endAbs = startAbs + BigInt(Math.round(Number(s.duration) || 0)) * MICROS;

  const isError = errorFromAttributes(attributes);
  const statusMessage =
    typeof attributes['otel.status_description'] === 'string'
      ? attributes['otel.status_description']
      : '';

  return {
    traceId: String(s.traceID || trace.traceID || '').toLowerCase(),
    spanId: String(s.spanID || '').toLowerCase(),
    parentSpanId,
    name: typeof s.operationName === 'string' ? s.operationName : '(unnamed)',
    service,
    kind: normalizeKind(attributes['span.kind'] ?? attributes['otel.span.kind']),
    startAbs,
    endAbs,
    statusCode: isError ? 'error' : 'unset',
    statusMessage,
    attributes,
    resourceAttributes,
    events: (Array.isArray(s.logs) ? s.logs : []).map((log) => {
      const fields = tagsToObject(log.fields);
      const name = typeof fields.event === 'string' ? fields.event : 'log';
      delete fields.event;
      return {
        timeAbs: BigInt(Math.round(Number(log.timestamp) || 0)) * MICROS,
        name,
        attributes: fields,
      };
    }),
    links,
    raw: s,
  };
}
