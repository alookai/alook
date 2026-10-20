// Zipkin JSON v2 parser.
//
//   [ { traceId, id, parentId, name, kind, timestamp, duration,
//       localEndpoint: { serviceName }, tags: {}, annotations: [] } ]
//
// Timestamps and durations are microseconds. Zipkin also allows a list of
// lists (one inner list per trace), which /api/v2/traces returns.

import { ParseError, errorFromAttributes, normalizeKind } from './common.js';

const MICROS = 1000n;

function flatten(doc) {
  if (!Array.isArray(doc)) return null;
  if (doc.length === 0) return [];
  if (Array.isArray(doc[0])) return doc.flat();
  return doc;
}

export function looksLikeZipkin(doc) {
  const list = flatten(doc);
  if (!list || list.length === 0) return false;
  return list.some(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof s.traceId === 'string' &&
      typeof s.id === 'string' &&
      !Array.isArray(s.tags),
  );
}

/** @returns {object[]} raw normalized spans */
export function parseZipkin(doc) {
  const list = flatten(doc);
  if (!list) throw new ParseError('Zipkin v2 document must be an array of spans');
  return list.filter((s) => s && typeof s === 'object').map(normalizeSpan);
}

function normalizeSpan(s) {
  const attributes = { ...(s.tags && typeof s.tags === 'object' ? s.tags : {}) };
  const local = s.localEndpoint || {};
  const remote = s.remoteEndpoint || null;
  if (remote && remote.serviceName) attributes['peer.service'] = remote.serviceName;
  if (local.ipv4) attributes['net.host.ip'] = local.ipv4;
  if (s.shared === true) attributes['zipkin.shared'] = true;
  if (s.debug === true) attributes['zipkin.debug'] = true;

  const startAbs = BigInt(Math.round(Number(s.timestamp) || 0)) * MICROS;
  const endAbs = startAbs + BigInt(Math.round(Number(s.duration) || 0)) * MICROS;
  const isError = errorFromAttributes(attributes);

  return {
    traceId: String(s.traceId || '').toLowerCase(),
    spanId: String(s.id || '').toLowerCase(),
    parentSpanId: s.parentId ? String(s.parentId).toLowerCase() : '',
    name: typeof s.name === 'string' && s.name !== '' ? s.name : '(unnamed)',
    service: typeof local.serviceName === 'string' ? local.serviceName : 'unknown_service',
    kind: normalizeKind(s.kind),
    startAbs,
    endAbs,
    statusCode: isError ? 'error' : 'unset',
    statusMessage: typeof attributes.error === 'string' ? attributes.error : '',
    attributes,
    resourceAttributes: local.serviceName ? { 'service.name': local.serviceName } : {},
    events: (Array.isArray(s.annotations) ? s.annotations : []).map((a) => ({
      timeAbs: BigInt(Math.round(Number(a.timestamp) || 0)) * MICROS,
      name: typeof a.value === 'string' ? a.value : '',
      attributes: {},
    })),
    links: [],
    raw: s,
  };
}
