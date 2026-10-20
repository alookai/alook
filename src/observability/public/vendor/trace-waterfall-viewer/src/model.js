// Normalized span model and tree building.
//
// Parsers hand us "raw normalized spans" with absolute BigInt nanosecond
// timestamps. Absolute epoch nanoseconds do not fit in a JS number
// (1.7e18 > Number.MAX_SAFE_INTEGER), so we keep them as BigInt until the trace
// origin is known, then store every span as an offset from that origin. Offsets
// are small enough to be exact numbers even for traces spanning days.

/**
 * @typedef {object} Span
 * @property {string} uid            unique within the trace (spanId, or spanId#n when duplicated)
 * @property {string} spanId
 * @property {string} parentSpanId   '' when this is a root span
 * @property {string|null} parentUid  resolved parent, null for roots and orphans
 * @property {boolean} orphaned      parentSpanId set but no such span in the input
 * @property {number} start          nanoseconds after the trace origin
 * @property {number} duration       nanoseconds
 * @property {number} selfTime       duration minus time covered by children
 * @property {number} depth
 * @property {string[]} childUids
 */

/** Clamp helper: a span that ends before it starts is treated as instantaneous. */
function durationOf(startAbs, endAbs) {
  if (endAbs <= startAbs) return 0n;
  return endAbs - startAbs;
}

function isSharedServerSpan(raw) {
  return raw.attributes && raw.attributes['zipkin.shared'] === true;
}

/**
 * Build the trace model from raw normalized spans.
 *
 * @param {object[]} rawSpans
 * @returns {{
 *   spans: Span[], byUid: Map<string, Span>, roots: Span[], order: Span[],
 *   orphans: Span[], traceIds: string[], services: string[],
 *   startAbs: bigint, duration: number, warnings: string[]
 * }}
 */
export function buildTrace(rawSpans) {
  if (!Array.isArray(rawSpans) || rawSpans.length === 0) {
    throw new Error('buildTrace requires at least one span');
  }
  const warnings = [];

  // ---- 1. trace origin -----------------------------------------------------
  let originAbs = null;
  let endAbsMax = null;
  for (const r of rawSpans) {
    const end = r.endAbs > r.startAbs ? r.endAbs : r.startAbs;
    if (originAbs === null || r.startAbs < originAbs) originAbs = r.startAbs;
    if (endAbsMax === null || end > endAbsMax) endAbsMax = end;
  }

  // ---- 2. assign uids, resolve duplicate span ids --------------------------
  const groups = new Map(); // spanId -> raw spans sharing it
  for (const r of rawSpans) {
    const id = r.spanId || '';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  const spans = [];
  const byUid = new Map();
  const primaryUidBySpanId = new Map();

  for (const [spanId, group] of groups) {
    if (spanId === '') {
      warnings.push(`${group.length} span(s) have no span id and cannot be linked to a parent.`);
    }
    // Zipkin "shared" spans: the client and the server report the same span id.
    // Order them outermost first — non-shared (the caller) before shared (the
    // callee) — then chain each one inside the previous, as the Zipkin UI does.
    const ordered = [...group].sort((a, b) => {
      const shared = Number(isSharedServerSpan(a)) - Number(isSharedServerSpan(b));
      return shared !== 0 ? shared : Number(a.startAbs - b.startAbs);
    });

    const made = ordered.map((raw, i) => {
      const uid = ordered.length === 1 && spanId !== '' ? spanId : `${spanId}#${i}`;
      const span = makeSpan(raw, uid, originAbs);
      spans.push(span);
      byUid.set(uid, span);
      return span;
    });
    for (let i = 1; i < made.length; i++) made[i].parentUid = made[i - 1].uid;

    // Spans elsewhere in the file that name this id as their parent were
    // emitted by the innermost reporter, so they belong under the last link.
    if (spanId !== '') primaryUidBySpanId.set(spanId, made[made.length - 1].uid);

    if (made.length > 1) {
      warnings.push(
        `Span id ${spanId} was reported ${made.length} times; the copies are nested ` +
          'caller-first (this is normal for Zipkin shared client/server spans).',
      );
    }
  }

  // ---- 3. link parents -----------------------------------------------------
  const orphans = [];
  for (const span of spans) {
    if (span.parentUid) continue; // already forced (shared span)
    if (span.parentSpanId === '') continue; // root
    const parentUid = primaryUidBySpanId.get(span.parentSpanId);
    if (parentUid === undefined || parentUid === span.uid) {
      span.orphaned = true;
      orphans.push(span);
      continue;
    }
    span.parentUid = parentUid;
  }

  // ---- 4. break cycles -----------------------------------------------------
  for (const span of spans) {
    const seen = new Set([span.uid]);
    let cursor = span.parentUid;
    while (cursor) {
      if (seen.has(cursor)) {
        warnings.push(`Cycle detected at span ${span.spanId}; its parent link was dropped.`);
        span.parentUid = null;
        span.cycleBroken = true;
        break;
      }
      seen.add(cursor);
      cursor = byUid.get(cursor) ? byUid.get(cursor).parentUid : null;
    }
  }

  // ---- 5. children ---------------------------------------------------------
  for (const span of spans) {
    if (!span.parentUid) continue;
    const parent = byUid.get(span.parentUid);
    if (parent) parent.childUids.push(span.uid);
  }
  const byStart = (a, b) => a.start - b.start || a.name.localeCompare(b.name);
  for (const span of spans) {
    span.childUids.sort((x, y) => byStart(byUid.get(x), byUid.get(y)));
  }

  const roots = spans.filter((s) => !s.parentUid).sort(byStart);
  if (roots.length === 0) {
    warnings.push('No root span found — every span references a parent inside the trace.');
  }

  // ---- 6. depth-first order + depth ----------------------------------------
  const order = [];
  const stack = [...roots].reverse().map((s) => ({ span: s, depth: 0 }));
  while (stack.length) {
    const { span, depth } = stack.pop();
    span.depth = depth;
    span.index = order.length;
    order.push(span);
    for (let i = span.childUids.length - 1; i >= 0; i--) {
      stack.push({ span: byUid.get(span.childUids[i]), depth: depth + 1 });
    }
  }

  // ---- 7. self time --------------------------------------------------------
  for (const span of spans) {
    span.selfTime = computeSelfTime(span, byUid);
  }

  const traceIds = [...new Set(spans.map((s) => s.traceId).filter(Boolean))];
  if (traceIds.length > 1) {
    warnings.push(`Input contains ${traceIds.length} distinct trace ids; all are shown together.`);
  }
  if (orphans.length > 0) {
    warnings.push(
      `${orphans.length} orphaned span(s): their parent span id is not present in this ` +
        'file. Usually the parent was sampled away, dropped, or context was lost across an ' +
        'async boundary.',
    );
  }

  const services = [...new Set(spans.map((s) => s.service))].sort();

  return {
    spans,
    byUid,
    roots,
    order,
    orphans,
    traceIds,
    services,
    startAbs: originAbs,
    duration: Number(endAbsMax - originAbs),
    warnings,
  };
}

function makeSpan(raw, uid, originAbs) {
  const dur = durationOf(raw.startAbs, raw.endAbs);
  return {
    uid,
    traceId: raw.traceId,
    spanId: raw.spanId,
    parentSpanId: raw.parentSpanId || '',
    parentUid: null,
    orphaned: false,
    name: raw.name,
    service: raw.service,
    kind: raw.kind,
    statusCode: raw.statusCode,
    statusMessage: raw.statusMessage,
    start: Number(raw.startAbs - originAbs),
    duration: Number(dur),
    startAbs: raw.startAbs,
    endAbs: raw.startAbs + dur,
    selfTime: 0,
    depth: 0,
    index: 0,
    childUids: [],
    attributes: raw.attributes || {},
    resourceAttributes: raw.resourceAttributes || {},
    events: (raw.events || []).map((e) => ({
      name: e.name,
      offset: Number(e.timeAbs - originAbs),
      attributes: e.attributes || {},
    })),
    links: raw.links || [],
    raw: raw.raw,
  };
}

/**
 * Self time = the span's duration minus the union of its children's intervals,
 * clamped to the parent's own window. Using the union (rather than the sum)
 * keeps concurrent children from over-counting.
 */
export function computeSelfTime(span, byUid) {
  if (span.childUids.length === 0) return span.duration;
  const spanEnd = span.start + span.duration;
  const intervals = [];
  for (const uid of span.childUids) {
    const c = byUid.get(uid);
    const s = Math.max(c.start, span.start);
    const e = Math.min(c.start + c.duration, spanEnd);
    if (e > s) intervals.push([s, e]);
  }
  return span.duration - unionLength(intervals);
}

/** Total length covered by a set of [start, end) intervals. */
export function unionLength(intervals) {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}
