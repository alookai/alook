// Virtualized waterfall renderer.
//
// Only the rows inside the viewport (plus a small overscan) exist in the DOM,
// which is what keeps a 10k-span trace responsive. Row height is fixed so the
// visible window can be derived from scrollTop arithmetic alone.

import { formatDuration } from '../stats.js';

export const ROW_HEIGHT = 26;
const OVERSCAN = 8;

export function createWaterfall(root, handlers = {}) {
  const viewport = root.querySelector('[data-role="viewport"]');
  const spacer = root.querySelector('[data-role="spacer"]');
  const layer = root.querySelector('[data-role="rows"]');
  const axis = root.querySelector('[data-role="axis"]');

  let state = null;
  const pool = new Map(); // row index -> element

  viewport.addEventListener('scroll', () => draw(), { passive: true });

  layer.addEventListener('click', (event) => {
    const rowEl = event.target.closest('.row');
    if (!rowEl) return;
    const uid = rowEl.dataset.uid;
    if (event.target.closest('.twisty')) {
      if (handlers.onToggle) handlers.onToggle(uid);
      return;
    }
    if (handlers.onSelect) handlers.onSelect(uid);
  });

  layer.addEventListener('dblclick', (event) => {
    const rowEl = event.target.closest('.row');
    if (rowEl && handlers.onZoomToSpan) handlers.onZoomToSpan(rowEl.dataset.uid);
  });

  function setState(next) {
    state = next;
    spacer.style.height = `${state.rows.length * ROW_HEIGHT}px`;
    draw(true);
  }

  function draw(force = false) {
    if (!state) return;
    const { rows } = state;
    const scrollTop = viewport.scrollTop;
    const height = viewport.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(rows.length - 1, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

    if (force) {
      for (const el of pool.values()) el.remove();
      pool.clear();
    }
    for (const [index, el] of pool) {
      if (index < first || index > last) {
        el.remove();
        pool.delete(index);
      }
    }
    for (let i = first; i <= last; i++) {
      let el = pool.get(i);
      if (!el) {
        el = buildRow();
        pool.set(i, el);
        layer.appendChild(el);
      }
      fillRow(el, rows[i], i, state);
    }
    drawAxis(axis, state);
  }

  function scrollToIndex(index) {
    const top = index * ROW_HEIGHT;
    const height = viewport.clientHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + height) {
      viewport.scrollTop = top + ROW_HEIGHT - height;
    }
  }

  return { setState, redraw: () => draw(true), scrollToIndex, viewport };
}

function buildRow() {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML =
    '<div class="row-label">' +
    '<span class="twisty" aria-hidden="true"></span>' +
    '<span class="svc-dot"></span>' +
    '<span class="row-name"></span>' +
    '<span class="row-service"></span>' +
    '</div>' +
    '<div class="row-track"><div class="bar"><i class="bar-self"></i></div>' +
    '<span class="bar-label"></span></div>';
  return el;
}

function fillRow(el, span, index, state) {
  const { view, colors, cp, selectedUid, showCritical, matches } = state;
  el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  el.dataset.uid = span.uid;
  el.classList.toggle('is-selected', span.uid === selectedUid);
  el.classList.toggle('is-error', span.statusCode === 'error');
  el.classList.toggle('is-orphan', span.orphaned);
  el.classList.toggle('is-critical', showCritical && cp.uids.has(span.uid));
  el.classList.toggle('is-match', Boolean(matches && matches.has(span.uid)));

  const label = el.firstChild;
  label.style.paddingLeft = `${6 + span.depth * 14}px`;
  const twisty = label.children[0];
  const collapsed = state.collapsed.has(span.uid);
  twisty.textContent = span.childUids.length ? (collapsed ? '▸' : '▾') : '';
  twisty.className = `twisty${span.childUids.length ? ' has-children' : ''}`;

  const color = colors.get(span.service);
  label.children[1].style.background = color;
  const name = label.children[2];
  name.textContent = span.name;
  name.title = `${span.name} — ${span.service}`;
  label.children[3].textContent = span.service;

  const track = el.lastChild;
  const bar = track.firstChild;
  const spanView = view.end - view.start || 1;
  const left = ((span.start - view.start) / spanView) * 100;
  const width = (span.duration / spanView) * 100;
  const visible = left < 100 && left + width > 0;
  bar.style.display = visible ? '' : 'none';
  if (visible) {
    bar.style.left = `${clamp(left, -50, 150)}%`;
    bar.style.width = `${Math.max(Math.min(width, 200), 0.15)}%`;
    bar.style.background = color;
    // Self time is drawn as the solid head of the bar; the remainder is the
    // time this span spent waiting on its children.
    const selfPct = span.duration > 0 ? (span.selfTime / span.duration) * 100 : 100;
    bar.firstChild.style.width = `${selfPct}%`;
  }
  const barLabel = track.lastChild;
  barLabel.textContent = formatDuration(span.duration);
  const anchor = clamp(left + width, 0, 100);
  barLabel.style.left = `${anchor}%`;
  barLabel.classList.toggle('flip', anchor > 82);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Nice round tick spacing for the time axis: 1, 2 or 5 times a power of ten. */
export function tickStep(spanNs, targetTicks = 8) {
  const raw = spanNs / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  // Round the step up so the tick count never much exceeds the target.
  const step = norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10;
  return step * pow;
}

export function axisTicks(view, targetTicks = 8) {
  const span = view.end - view.start;
  if (!(span > 0)) return [];
  const step = tickStep(span, targetTicks);
  const ticks = [];
  const firstTick = Math.ceil(view.start / step) * step;
  for (let t = firstTick; t <= view.end + 1e-6; t += step) {
    ticks.push({ value: t, pct: ((t - view.start) / span) * 100 });
  }
  return ticks;
}

function drawAxis(axis, state) {
  if (!axis) return;
  const ticks = axisTicks(state.view);
  axis.replaceChildren(
    ...ticks.map((tick) => {
      const el = document.createElement('span');
      el.className = 'tick';
      el.style.left = `${tick.pct}%`;
      el.textContent = formatDuration(tick.value);
      return el;
    }),
  );
  const grid = state.gridEl;
  if (grid) {
    grid.replaceChildren(
      ...ticks.map((tick) => {
        const el = document.createElement('i');
        el.style.left = `${tick.pct}%`;
        return el;
      }),
    );
  }
}
