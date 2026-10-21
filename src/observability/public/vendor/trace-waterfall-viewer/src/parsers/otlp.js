// OTLP/JSON parser.
//
// Accepts an ExportTraceServiceRequest document:
//   { resourceSpans: [ { resource, scopeSpans: [ { scope, spans: [...] } ] } ] }
//
// Also tolerates the older `instrumentationLibrarySpans` key and documents
// wrapped in { resourceSpans: ... } vs a bare array of resourceSpans, both of
// which turn up in files produced by different collector versions.

import {
  ParseError,
  anyValue,
  isZeroId,
  kvListToObject,
  normalizeId,
  normalizeKind,
  toBigIntNanos,
} from './common.js';

const STATUS_BY_NUMBER = ['unset', 'ok', 'error'];

function normalizeStatus(status) {
  if (!status || typeof status !== 'object') return { statusCode: 'unset', statusMessage: '' };
  const message = typeof status.message === 'string' ? status.message : '';
  const code = status.code;
  if (typeof code === 'number') {
    return { statusCode: STATUS_BY_NUMBER[code] || 'unset', statusMessage: message };
  }
  if (typeof code === 'string') {
    const s = code.toLowerCase().replace(/^status_code_/, '');
    return {
      statusCode: STATUS_BY_NUMBER.includes(s) ? s : 'unset',
      statusMessage: message,
    };
  }
  return { statusCode: 'unset', statusMessage: message };
}

function serviceNameOf(resourceAttributes, scope) {
  const name = resourceAttributes['service.name'];
  if (typeof name === 'string' && name !== '') return name;
  if (scope && typeof scope.name === 'string' && scope.name !== '') return scope.name;
  return 'unknown_service';
}

export function resourceSpansOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.resourceSpans)) return doc.resourceSpans;
  if (doc && Array.isArray(doc.resource_spans)) return doc.resource_spans;
  return null;
}

/** True when `doc` looks like an OTLP/JSON trace export. */
export function looksLikeOtlp(doc) {
  const rs = resourceSpansOf(doc);
  if (!rs || rs.length === 0) return false;
  return rs.some(
    (r) => r && typeof r === 'object' && (r.scopeSpans || r.scope_spans || r.instrumentationLibrarySpans),
  );
}

/**
 * @param {object|object[]} doc  one ExportTraceServiceRequest, or an array of them
 * @returns {object[]} raw normalized spans
 */
export function parseOtlp(doc) {
  const docs = Array.isArray(doc) && !resourceSpansOf(doc) ? doc : [doc];
  const spans = [];
  for (const d of docs) {
    const resourceSpans = resourceSpansOf(d);
    if (!resourceSpans) throw new ParseError('OTLP document has no resourceSpans');
    for (const rs of resourceSpans) {
      if (!rs || typeof rs !== 'object') continue;
      const resourceAttributes = kvListToObject(rs.resource ? rs.resource.attributes : []);
      const scopeSpans =
        rs.scopeSpans || rs.scope_spans || rs.instrumentationLibrarySpans || [];
      for (const ss of scopeSpans) {
        if (!ss || typeof ss !== 'object') continue;
        const scope = ss.scope || ss.instrumentationLibrary || null;
        const service = serviceNameOf(resourceAttributes, scope);
        for (const s of ss.spans || []) {
          if (!s || typeof s !== 'object') continue;
          spans.push(normalizeSpan(s, service, resourceAttributes, scope));
        }
      }
    }
  }
  return spans;
}

function normalizeSpan(s, service, resourceAttributes, scope) {
  const parentSpanId = normalizeId(s.parentSpanId ?? s.parent_span_id ?? '');
  const { statusCode, statusMessage } = normalizeStatus(s.status);
  const attributes = kvListToObject(s.attributes);
  if (scope && scope.name) attributes['otel.scope.name'] = scope.name;
  if (scope && scope.version) attributes['otel.scope.version'] = scope.version;

  return {
    traceId: normalizeId(s.traceId ?? s.trace_id ?? ''),
    spanId: normalizeId(s.spanId ?? s.span_id ?? ''),
    parentSpanId: isZeroId(parentSpanId) ? '' : parentSpanId,
    name: typeof s.name === 'string' ? s.name : '(unnamed)',
    service,
    kind: normalizeKind(s.kind),
    startAbs: toBigIntNanos(s.startTimeUnixNano ?? s.start_time_unix_nano ?? 0),
    endAbs: toBigIntNanos(s.endTimeUnixNano ?? s.end_time_unix_nano ?? 0),
    statusCode,
    statusMessage,
    attributes,
    resourceAttributes,
    events: (s.events || []).map((e) => ({
      timeAbs: toBigIntNanos(e.timeUnixNano ?? e.time_unix_nano ?? 0),
      name: typeof e.name === 'string' ? e.name : '',
      attributes: kvListToObject(e.attributes),
    })),
    links: (s.links || []).map((l) => ({
      traceId: normalizeId(l.traceId ?? l.trace_id ?? ''),
      spanId: normalizeId(l.spanId ?? l.span_id ?? ''),
      attributes: kvListToObject(l.attributes),
    })),
    raw: s,
  };
}

export { anyValue };
