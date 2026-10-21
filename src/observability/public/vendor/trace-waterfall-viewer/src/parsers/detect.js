// Format auto-detection.
//
// Supported inputs:
//   otlp-json    ExportTraceServiceRequest (resourceSpans/scopeSpans/spans)
//   otlp-ndjson  OpenTelemetry Collector `file` exporter output: one
//                ExportTraceServiceRequest per line
//   jaeger-json  Jaeger query API / UI export ({ data: [ { spans, processes } ] })
//   zipkin-json  Zipkin v2 (array of spans, or array of arrays of spans)
//
// Detection is structural, never filename-based: the same file can arrive by
// drag-and-drop, file picker or paste.

import { ParseError } from './common.js';
import { looksLikeOtlp, parseOtlp } from './otlp.js';
import { looksLikeJaeger, parseJaeger } from './jaeger.js';
import { looksLikeZipkin, parseZipkin } from './zipkin.js';

export const FORMAT_LABELS = {
  'otlp-json': 'OTLP/JSON',
  'otlp-ndjson': 'OTLP newline-delimited JSON (collector file exporter)',
  'jaeger-json': 'Jaeger JSON',
  'zipkin-json': 'Zipkin JSON v2',
};

/** Parse text that may be a single JSON document or newline-delimited JSON. */
export function parseJsonOrNdjson(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') throw new ParseError('Input is empty');
  try {
    return { documents: [JSON.parse(trimmed)], ndjson: false };
  } catch (singleErr) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) {
      throw new ParseError(`Input is not valid JSON: ${singleErr.message}`);
    }
    const documents = [];
    lines.forEach((line, i) => {
      try {
        documents.push(JSON.parse(line));
      } catch (err) {
        throw new ParseError(`Line ${i + 1} is not valid JSON: ${err.message}`);
      }
    });
    return { documents, ndjson: true };
  }
}

/** Identify the format of already-parsed documents. */
export function detectFormat(documents, ndjson = false) {
  const sample = documents.find((d) => d !== null && d !== undefined);
  if (sample === undefined) throw new ParseError('No JSON documents found in input');
  if (looksLikeOtlp(sample)) return ndjson ? 'otlp-ndjson' : 'otlp-json';
  if (looksLikeJaeger(sample)) return 'jaeger-json';
  if (looksLikeZipkin(sample)) return 'zipkin-json';
  throw new ParseError(
    'Unrecognised trace format. Expected OTLP/JSON, Jaeger JSON, Zipkin JSON v2, ' +
      'or newline-delimited OTLP from the collector file exporter.',
  );
}

/**
 * Detect the format of `text` and parse it.
 * @returns {{ format: string, formatLabel: string, spans: object[], documentCount: number }}
 */
export function parseTraceText(text) {
  const { documents, ndjson } = parseJsonOrNdjson(text);
  const format = detectFormat(documents, ndjson);
  const spans = [];
  for (const doc of documents) {
    if (doc === null || doc === undefined) continue;
    if (format === 'otlp-json' || format === 'otlp-ndjson') spans.push(...parseOtlp(doc));
    else if (format === 'jaeger-json') spans.push(...parseJaeger(doc));
    else spans.push(...parseZipkin(doc));
  }
  if (spans.length === 0) throw new ParseError('No spans found in input');
  return {
    format,
    formatLabel: FORMAT_LABELS[format],
    spans,
    documentCount: documents.length,
  };
}
