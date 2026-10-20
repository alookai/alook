// Span detail panel.
//
// Everything is built with DOM APIs rather than innerHTML: span names,
// attribute values and status messages come from an untrusted file and must
// never be interpreted as markup.

import { formatDuration, formatPercent } from '../stats.js';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** A small "?" button; ui.js delegates clicks on these to the popover. */
export function conceptButton(id, label = 'Explain') {
  return el('button', {
    class: 'concept-btn',
    type: 'button',
    'data-concept': id,
    'aria-label': label,
    title: label,
    text: '?',
  });
}

export function renderDetail(container, ctx) {
  const { span, trace, cp, colors } = ctx;
  container.replaceChildren();
  if (!span) {
    container.appendChild(
      el('p', { class: 'muted', text: 'Select a span to see its attributes, events and links.' }),
    );
    return;
  }

  container.appendChild(
    el('div', { class: 'detail-head' }, [
      el('span', { class: 'svc-dot', style: { background: colors.get(span.service) } }),
      el('h2', { class: 'detail-title', text: span.name }),
      el('div', { class: 'detail-sub', text: span.service }),
    ]),
  );

  // --- badges ---------------------------------------------------------------
  const badges = el('div', { class: 'badges' }, [
    el('span', { class: 'badge', text: `kind: ${span.kind}` }),
    conceptButton('span-kind', 'What is a span kind?'),
    el('span', {
      class: `badge status-${span.statusCode}`,
      text: `status: ${span.statusCode}`,
    }),
  ]);
  if (span.orphaned) {
    badges.append(
      el('span', { class: 'badge badge-warn', text: 'orphaned' }),
      conceptButton('orphan', 'Why is this span orphaned?'),
    );
  }
  if (cp.uids.has(span.uid)) {
    badges.append(
      el('span', { class: 'badge badge-critical', text: 'on critical path' }),
      conceptButton('critical-path', 'What is the critical path?'),
    );
  }
  container.appendChild(badges);

  if (span.statusMessage) {
    container.appendChild(el('p', { class: 'status-message', text: span.statusMessage }));
  }

  // --- timing ---------------------------------------------------------------
  const cpTime = cp.byUid.get(span.uid) || 0;
  container.appendChild(
    section(
      'Timing',
      defList([
        ['Start offset', formatDuration(span.start)],
        ['Total time', formatDuration(span.duration)],
        [
          'Self time',
          `${formatDuration(span.selfTime)} (${formatPercent(span.selfTime, span.duration)} of total)`,
          'self-time',
        ],
        ['Children', String(span.childUids.length)],
        [
          'On critical path',
          cpTime > 0
            ? `${formatDuration(cpTime)} (${formatPercent(cpTime, trace.duration)} of the trace)`
            : 'no',
          'critical-path',
        ],
        ['Wall-clock start', absoluteTime(trace.startAbs, span.start)],
      ]),
    ),
  );

  // --- identity -------------------------------------------------------------
  container.appendChild(
    section(
      'Identity',
      defList([
        ['Trace id', span.traceId || '—', 'trace-id'],
        ['Span id', span.spanId || '—'],
        [
          'Parent span id',
          span.parentSpanId === '' ? '— (root span)' : span.parentSpanId,
          span.orphaned ? 'orphan' : null,
        ],
      ]),
    ),
  );

  container.appendChild(section('Span attributes', kvTable(span.attributes)));
  container.appendChild(section('Resource attributes', kvTable(span.resourceAttributes)));

  // --- events ---------------------------------------------------------------
  if (span.events.length) {
    container.appendChild(
      section(
        `Events (${span.events.length})`,
        el(
          'ul',
          { class: 'events' },
          span.events.map((event) =>
            el('li', {}, [
              el('div', { class: 'event-head' }, [
                el('strong', { text: event.name || '(unnamed event)' }),
                el('span', { class: 'muted', text: ` @ ${formatDuration(event.offset)}` }),
              ]),
              Object.keys(event.attributes).length ? kvTable(event.attributes) : null,
            ]),
          ),
        ),
      ),
    );
  }

  // --- links ----------------------------------------------------------------
  if (span.links.length) {
    container.appendChild(
      section(
        `Links (${span.links.length})`,
        el(
          'ul',
          { class: 'events' },
          span.links.map((link) =>
            el('li', {}, [
              el('div', { class: 'mono small', text: `${link.traceId} / ${link.spanId}` }),
              Object.keys(link.attributes || {}).length ? kvTable(link.attributes) : null,
            ]),
          ),
        ),
        'span-links',
      ),
    );
  }

  // --- raw ------------------------------------------------------------------
  const raw = el('details', { class: 'raw' }, [
    el('summary', { text: 'Raw span JSON (as it appeared in the file)' }),
    el('pre', {}, [el('code', { text: JSON.stringify(span.raw, null, 2) })]),
  ]);
  container.appendChild(raw);
}

function section(title, body, concept = null) {
  return el('section', { class: 'detail-section' }, [
    el('h3', {}, [title, concept ? conceptButton(concept, title) : null]),
    body,
  ]);
}

function defList(rows) {
  const list = el('dl', { class: 'kv' });
  for (const [key, value, concept] of rows) {
    list.appendChild(el('dt', {}, [key, concept ? conceptButton(concept, key) : null]));
    list.appendChild(el('dd', { class: 'mono', text: value }));
  }
  return list;
}

function kvTable(obj) {
  const keys = Object.keys(obj || {}).sort();
  if (keys.length === 0) return el('p', { class: 'muted small', text: 'none' });
  const list = el('dl', { class: 'kv' });
  for (const key of keys) {
    list.appendChild(el('dt', { class: 'mono', text: key }));
    list.appendChild(el('dd', { class: 'mono', text: formatValue(obj[key]) }));
  }
  return list;
}

export function formatValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function absoluteTime(originAbs, offsetNs) {
  try {
    const ms = Number((originAbs + BigInt(Math.round(offsetNs))) / 1000000n);
    return new Date(ms).toISOString();
  } catch {
    return '—';
  }
}
