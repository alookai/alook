// Shared helpers for the format parsers.
//
// Every parser produces the same "raw normalized span" shape:
//
//   {
//     traceId, spanId, parentSpanId,   // lowercase hex, parentSpanId may be ''
//     name, service, kind,             // kind: one of KINDS below
//     startAbs, endAbs,                // BigInt, nanoseconds since epoch
//     statusCode,                      // 'unset' | 'ok' | 'error'
//     statusMessage,
//     attributes, resourceAttributes,  // plain objects, values are JS scalars/arrays
//     events, links,                   // see below
//     raw                              // the untouched source object
//   }
//
// events: [{ timeAbs: BigInt, name: string, attributes: object }]
// links:  [{ traceId, spanId, attributes }]

export const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a standard base64 string to a lowercase hex string, without Buffer. */
export function base64ToHex(input) {
  const s = String(input).replace(/[^A-Za-z0-9+/]/g, '');
  let bits = 0;
  let acc = 0;
  let hex = '';
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (acc >> bits) & 0xff;
      hex += byte.toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/**
 * OTLP/JSON permits either hex (the JSON mapping used by most exporters) or
 * base64 (the canonical proto3 JSON mapping) for trace/span ids.
 */
export function normalizeId(id) {
  if (id === null || id === undefined) return '';
  if (typeof id !== 'string') return String(id);
  if (id === '') return '';
  if (/^[0-9a-fA-F]+$/.test(id) && id.length % 2 === 0) return id.toLowerCase();
  return base64ToHex(id);
}

/** An id of all zeroes means "absent" in OTLP. */
export function isZeroId(id) {
  return id === '' || /^0+$/.test(id);
}

export function toBigIntNanos(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.round(value));
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^-?\d+$/.test(t)) return BigInt(t);
    const n = Number(t);
    return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
  }
  return 0n;
}

/** Decode an OTLP AnyValue into a plain JS value. */
export function anyValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('boolValue' in v) return v.boolValue;
  if ('intValue' in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('bytesValue' in v) return base64ToHex(v.bytesValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(anyValue);
  if ('kvlistValue' in v) return kvListToObject(v.kvlistValue.values || []);
  return null;
}

/** Convert an OTLP KeyValue list into a plain object. */
export function kvListToObject(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) {
    if (!kv || typeof kv.key !== 'string') continue;
    out[kv.key] = anyValue(kv.value);
  }
  return out;
}

const OTLP_KIND_BY_NUMBER = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
];

export function normalizeKind(kind) {
  if (kind === null || kind === undefined || kind === '') return 'unspecified';
  if (typeof kind === 'number') return OTLP_KIND_BY_NUMBER[kind] || 'unspecified';
  const s = String(kind).toLowerCase().replace(/^span_kind_/, '');
  return KINDS.includes(s) ? s : 'unspecified';
}

/**
 * Heuristic error detection shared by the Jaeger and Zipkin parsers, which have
 * no first-class status field. Mirrors what the Jaeger and Zipkin UIs do.
 */
export function errorFromAttributes(attrs) {
  // Zipkin marks failures with an `error` tag whose value is the message, so any
  // non-empty string other than an explicit negative counts.
  if (attrs.error === true) return true;
  if (typeof attrs.error === 'string') {
    const v = attrs.error.trim().toLowerCase();
    if (v !== '' && v !== 'false' && v !== '0') return true;
  }
  const status = attrs['otel.status_code'] ?? attrs['status.code'];
  if (typeof status === 'string' && status.toUpperCase() === 'ERROR') return true;
  if (status === 2) return true;
  const http =
    attrs['http.response.status_code'] ?? attrs['http.status_code'] ?? attrs['http.status'];
  if (http !== undefined && Number(http) >= 500) return true;
  const rpc = attrs['rpc.grpc.status_code'];
  if (rpc !== undefined && Number(rpc) !== 0) return true;
  return false;
}

export class ParseError extends Error {}
