// Critical path analysis.
//
// The critical path is the chain of work that actually determines how long the
// trace took: shorten anything on it and the whole request gets faster;
// shorten anything off it and nothing changes.
//
// It is *not* simply "the longest child at every level". The correct definition
// walks backwards in time from the end of a span:
//
//   1. Start at the root, with a cursor at the root's end.
//   2. Look for the child that is still running latest but no later than the
//      cursor. The gap between that child's end and the cursor is the parent's
//      own work — it is on the critical path.
//   3. Recurse into that child over its own window, then move the cursor to the
//      child's start and repeat with the remaining, earlier children.
//   4. Whatever is left between the span's start and the cursor is again the
//      parent's own work.
//
// Concurrent children are handled correctly by construction: only the child
// that the parent was actually waiting on when it resumed lands on the path.
// Children that overhang the cursor (they outlive the window we are examining,
// e.g. a fire-and-forget span) are clamped to it rather than dropped.
//
// Further reading:
// https://www.distributed-tracing.com/trace-debugging-and-signal-correlation/finding-latency-bottlenecks-with-critical-path-analysis/

/**
 * @param {ReturnType<import('./model.js').buildTrace>} trace
 * @returns {{
 *   segments: {uid: string, start: number, end: number}[],
 *   uids: Set<string>,
 *   byUid: Map<string, number>,   // uid -> nanoseconds of critical path owned
 *   total: number,
 *   rootUid: string|null
 * }}
 */
export function computeCriticalPath(trace) {
  const empty = { segments: [], uids: new Set(), byUid: new Map(), total: 0, rootUid: null };
  if (!trace.roots.length) return empty;

  // The critical path hangs off whichever root determines the trace end.
  const root = trace.roots.reduce((best, s) => {
    const e = s.start + s.duration;
    const be = best.start + best.duration;
    if (e > be) return s;
    if (e === be && s.duration > best.duration) return s;
    return best;
  });

  const segments = [];
  walk(root, root.start, root.start + root.duration, trace.byUid, segments, 0);

  segments.sort((a, b) => a.start - b.start);
  const merged = mergeAdjacent(segments);

  const byUid = new Map();
  let total = 0;
  for (const seg of merged) {
    const len = seg.end - seg.start;
    total += len;
    byUid.set(seg.uid, (byUid.get(seg.uid) || 0) + len);
  }
  return { segments: merged, uids: new Set(byUid.keys()), byUid, total, rootUid: root.uid };
}

const MAX_DEPTH = 10000; // guards against pathological inputs

function walk(span, from, to, byUid, out, depth) {
  if (to <= from || depth > MAX_DEPTH) return;

  const children = span.childUids
    .map((uid) => byUid.get(uid))
    .filter(Boolean)
    .sort((a, b) => b.start + b.duration - (a.start + a.duration));

  let cursor = to;
  for (let i = 0; i < children.length && cursor > from; i++) {
    const child = children[i];
    const childEnd = Math.min(child.start + child.duration, cursor);
    const childStart = Math.max(child.start, from);
    if (childEnd <= childStart) continue; // no overlap with the remaining window

    if (childEnd < cursor) out.push({ uid: span.uid, start: childEnd, end: cursor });
    walk(child, childStart, childEnd, byUid, out, depth + 1);
    cursor = childStart;
  }

  if (cursor > from) out.push({ uid: span.uid, start: from, end: cursor });
}

function mergeAdjacent(segments) {
  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.uid === seg.uid && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}
