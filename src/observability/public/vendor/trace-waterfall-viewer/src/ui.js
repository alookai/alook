// Application wiring: state, filtering, keyboard, zoom/pan and exports.
//
// Nothing here touches the network. Files are read with FileReader, demo traces
// are compiled into demo/embedded.js, and exports are produced locally with
// Blob + object URLs. The trace never leaves the machine.

import { parseTraceText } from './parsers/detect.js';
import { ParseError } from './parsers/common.js';
import { buildTrace } from './model.js';
import { computeCriticalPath } from './criticalPath.js';
import { serviceSummary, traceStats, formatDuration, formatPercent } from './stats.js';
import { initTheme, cycleTheme, currentMode, isDark, serviceColor } from './theme.js';
import { createWaterfall, ROW_HEIGHT } from './render/waterfall.js';
import { createMinimap } from './render/minimap.js';
import { renderDetail, conceptButton, el } from './render/detail.js';
import { conceptById } from './concepts.js';
import {
  buildSvg,
  svgToPngBlob,
  shareableSubset,
  download,
  copyText,
} from './export.js';
import { DEMOS } from '../demo/embedded.js';

const MIN_VIEW_NS = 100; // never zoom in further than 100ns of span

const state = {
  trace: null,
  cp: null,
  rows: [],
  colors: new Map(),
  view: { start: 0, end: 1 },
  collapsed: new Set(),
  selectedUid: null,
  cursor: 0,
  filters: { query: '', services: new Set(), errorsOnly: false, criticalOnly: false },
  showCritical: true,
  matches: null,
  sourceName: '',
  format: '',
};

const dom = {};
let waterfall = null;
let minimap = null;

export function start() {
  initTheme();
  cacheDom();
  buildDemoButtons();
  wireEvents();
  updateThemeButton();
}

function cacheDom() {
  const byId = (id) => document.getElementById(id);
  Object.assign(dom, {
    welcome: byId('welcome'),
    welcomeClose: byId('welcome-close'),
    app: byId('app'),
    fileInput: byId('file-input'),
    pasteArea: byId('paste-area'),
    pasteBtn: byId('paste-load'),
    demoList: byId('demo-list'),
    dropHint: byId('drop-hint'),
    formatBadge: byId('format-badge'),
    summary: byId('summary'),
    warnings: byId('warnings'),
    search: byId('search'),
    serviceFilter: byId('service-filter'),
    errorsOnly: byId('errors-only'),
    criticalOnly: byId('critical-only'),
    criticalToggle: byId('critical-toggle'),
    minimap: byId('minimap'),
    waterfall: byId('waterfall'),
    detail: byId('detail'),
    stats: byId('stats'),
    popover: byId('popover'),
    toast: byId('toast'),
    matchCount: byId('match-count'),
  });
}

function buildDemoButtons() {
  dom.demoList.replaceChildren(
    ...DEMOS.map((demo) =>
      el('button', { class: 'demo-btn', type: 'button', 'data-demo': demo.id }, [
        el('strong', { text: demo.label }),
        el('span', { class: 'muted small', text: demo.blurb }),
      ]),
    ),
  );
}

function wireEvents() {
  waterfall = createWaterfall(dom.waterfall, {
    onSelect: (uid) => selectSpan(uid, { scroll: false }),
    onToggle: toggleCollapse,
    onZoomToSpan: zoomToSpan,
  });
  minimap = createMinimap(dom.minimap, {
    onViewChange: (start, end) => setView(start, end),
    onCenter: (t) => {
      const half = (state.view.end - state.view.start) / 2;
      setView(t - half, t + half);
    },
  });

  document.getElementById('btn-open').addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    if (file) readFile(file);
    dom.fileInput.value = '';
  });
  document.getElementById('btn-paste').addEventListener('click', () => showWelcome(true));
  dom.welcomeClose.addEventListener('click', () => showWelcome(false));
  dom.pasteBtn.addEventListener('click', () => {
    loadText(dom.pasteArea.value, 'pasted JSON');
  });
  dom.demoList.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-demo]');
    if (!btn) return;
    const demo = DEMOS.find((d) => d.id === btn.dataset.demo);
    if (demo) loadText(demo.text, demo.file);
  });

  document.getElementById('btn-theme').addEventListener('click', () => {
    cycleTheme();
    updateThemeButton();
  });
  document.addEventListener('twv:themechange', () => {
    recolor();
    if (state.trace) refresh();
  });

  document.getElementById('btn-export-svg').addEventListener('click', exportSvg);
  document.getElementById('btn-export-png').addEventListener('click', exportPng);
  document.getElementById('btn-copy-json').addEventListener('click', copySummary);
  document.getElementById('btn-help').addEventListener('click', () => showHelp());

  dom.search.addEventListener('input', () => {
    state.filters.query = dom.search.value.trim();
    refresh();
  });
  dom.serviceFilter.addEventListener('change', () => {
    state.filters.services = new Set(
      [...dom.serviceFilter.selectedOptions].map((o) => o.value),
    );
    refresh();
  });
  dom.errorsOnly.addEventListener('change', () => {
    state.filters.errorsOnly = dom.errorsOnly.checked;
    refresh();
  });
  dom.criticalOnly.addEventListener('change', () => {
    state.filters.criticalOnly = dom.criticalOnly.checked;
    refresh();
  });
  dom.criticalToggle.addEventListener('change', () => {
    state.showCritical = dom.criticalToggle.checked;
    refresh();
  });

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(0.6));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 0.6));
  document.getElementById('btn-zoom-reset').addEventListener('click', resetView);
  document.getElementById('btn-expand-all').addEventListener('click', () => {
    state.collapsed.clear();
    refresh();
  });
  document.getElementById('btn-collapse-all').addEventListener('click', collapseAll);

  wireDragAndDrop();
  wireZoomPan();
  wirePopovers();
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => {
    if (state.trace) {
      waterfall.redraw();
      minimap.redraw();
    }
  });
}

// --- loading ----------------------------------------------------------------

function wireDragAndDrop() {
  let depth = 0;
  const show = (on) => dom.dropHint.classList.toggle('active', on);
  document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    depth += 1;
    show(true);
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    show(false);
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) readFile(file);
    else {
      const text = event.dataTransfer && event.dataTransfer.getData('text');
      if (text) loadText(text, 'dropped text');
    }
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadText(String(reader.result), file.name);
  reader.onerror = () => toast(`Could not read ${file.name}`, true);
  reader.readAsText(file);
}

export function loadText(text, sourceName) {
  try {
    const parsed = parseTraceText(text);
    const trace = buildTrace(parsed.spans);
    const cp = computeCriticalPath(trace);
    state.trace = trace;
    state.cp = cp;
    state.format = parsed.formatLabel;
    state.sourceName = sourceName || 'trace';
    state.collapsed = new Set();
    state.selectedUid = null;
    state.cursor = 0;
    state.filters = { query: '', services: new Set(), errorsOnly: false, criticalOnly: false };
    dom.search.value = '';
    dom.errorsOnly.checked = false;
    dom.criticalOnly.checked = false;
    recolor();
    resetView();
    buildServiceFilter();
    showWelcome(false);
    dom.app.hidden = false;
    refresh();
    renderSummary();
    renderWarnings();
    toast(`Loaded ${trace.spans.length} spans from ${state.sourceName} (${state.format})`);
  } catch (err) {
    const message = err instanceof ParseError ? err.message : `${err.name}: ${err.message}`;
    toast(message, true);
    showWelcome(true);
    dom.pasteArea.setAttribute('aria-invalid', 'true');
  }
}

function recolor() {
  if (!state.trace) return;
  const dark = isDark();
  state.colors = new Map(
    state.trace.services.map((svc, i) => {
      const c = serviceColor(svc, i);
      return [svc, dark ? c.barDark : c.bar];
    }),
  );
}

function buildServiceFilter() {
  dom.serviceFilter.replaceChildren(
    ...state.trace.services.map((svc) =>
      el('option', { value: svc, text: svc }),
    ),
  );
  dom.serviceFilter.size = Math.min(Math.max(state.trace.services.length, 2), 6);
}

// --- filtering and rows -----------------------------------------------------

/** Spans matching the active filters, ignoring tree structure. */
export function matchingSpans(trace, cp, filters) {
  const query = filters.query.toLowerCase();
  const out = new Set();
  for (const span of trace.spans) {
    if (filters.errorsOnly && span.statusCode !== 'error') continue;
    if (filters.criticalOnly && !cp.uids.has(span.uid)) continue;
    if (filters.services.size && !filters.services.has(span.service)) continue;
    if (query && !spanMatchesText(span, query)) continue;
    out.add(span.uid);
  }
  return out;
}

function spanMatchesText(span, query) {
  if (span.name.toLowerCase().includes(query)) return true;
  if (span.service.toLowerCase().includes(query)) return true;
  if (span.spanId.includes(query) || span.traceId.includes(query)) return true;
  if (span.statusMessage && span.statusMessage.toLowerCase().includes(query)) return true;
  for (const [key, value] of Object.entries(span.attributes)) {
    if (key.toLowerCase().includes(query)) return true;
    if (String(value).toLowerCase().includes(query)) return true;
  }
  for (const [key, value] of Object.entries(span.resourceAttributes)) {
    if (key.toLowerCase().includes(query)) return true;
    if (String(value).toLowerCase().includes(query)) return true;
  }
  return false;
}

const NO_FILTER = (f) =>
  f.query === '' && !f.errorsOnly && !f.criticalOnly && f.services.size === 0;

/**
 * Rows to render: matching spans plus their ancestors (so the tree still reads
 * as a tree), minus anything hidden inside a collapsed subtree.
 */
export function computeRows(trace, collapsed, visible) {
  const rows = [];
  let skipDepth = -1;
  for (const span of trace.order) {
    if (skipDepth >= 0 && span.depth > skipDepth) continue;
    skipDepth = -1;
    if (visible && !visible.has(span.uid)) continue;
    rows.push(span);
    if (collapsed.has(span.uid)) skipDepth = span.depth;
  }
  return rows;
}

function withAncestors(trace, uids) {
  const out = new Set();
  for (const uid of uids) {
    let cursor = uid;
    while (cursor && !out.has(cursor)) {
      out.add(cursor);
      const span = trace.byUid.get(cursor);
      cursor = span ? span.parentUid : null;
    }
  }
  return out;
}

function refresh() {
  const { trace, cp, filters } = state;
  if (!trace) return;
  let visible = null;
  state.matches = null;
  if (!NO_FILTER(filters)) {
    const matches = matchingSpans(trace, cp, filters);
    state.matches = matches;
    visible = withAncestors(trace, matches);
    dom.matchCount.textContent = `${matches.size} of ${trace.spans.length} spans match`;
  } else {
    dom.matchCount.textContent = `${trace.spans.length} spans`;
  }
  state.rows = computeRows(trace, state.collapsed, visible);
  if (state.cursor >= state.rows.length) state.cursor = Math.max(0, state.rows.length - 1);

  const styles = getComputedStyle(document.documentElement);
  waterfall.setState({
    rows: state.rows,
    view: state.view,
    colors: state.colors,
    cp,
    collapsed: state.collapsed,
    selectedUid: state.selectedUid,
    showCritical: state.showCritical,
    matches: state.matches,
    gridEl: dom.waterfall.querySelector('[data-role="grid"]'),
  });
  minimap.setState({
    rows: state.rows,
    trace,
    cp,
    colors: state.colors,
    view: state.view,
    showCritical: state.showCritical,
    dim: styles.getPropertyValue('--minimap-dim').trim() || 'rgba(0,0,0,.45)',
    accent: styles.getPropertyValue('--accent').trim() || '#2f6feb',
  });
  renderStats();
  renderDetail(dom.detail, {
    span: state.selectedUid ? trace.byUid.get(state.selectedUid) : null,
    trace,
    cp,
    colors: state.colors,
  });
}

// --- summary, warnings, stats -----------------------------------------------

function renderSummary() {
  const { trace, cp } = state;
  const stats = traceStats(trace, cp);
  dom.formatBadge.textContent = state.format;
  const items = [
    ['duration', formatDuration(stats.duration)],
    ['spans', String(stats.spanCount)],
    ['services', String(stats.serviceCount)],
    ['depth', String(stats.depth)],
    ['errors', String(stats.errorCount)],
    ['orphans', String(stats.orphanCount)],
  ];
  dom.summary.replaceChildren(
    ...items.map(([label, value]) =>
      el('span', { class: `stat${label === 'errors' && stats.errorCount ? ' bad' : ''}` }, [
        el('b', { text: value }),
        el('span', { class: 'muted', text: ` ${label}` }),
      ]),
    ),
  );
}

function renderWarnings() {
  const warnings = state.trace.warnings;
  if (!warnings.length) {
    dom.warnings.replaceChildren();
    dom.warnings.hidden = true;
    return;
  }
  dom.warnings.hidden = false;
  dom.warnings.replaceChildren(
    ...warnings.map((text) =>
      el('div', { class: 'warning' }, [
        el('span', { text }),
        /orphan/i.test(text) ? conceptButton('orphan', 'Why is this span orphaned?') : null,
        /sampl|root span/i.test(text) ? conceptButton('sampling', 'Why are spans missing?') : null,
      ]),
    ),
  );
}

function renderStats() {
  const { trace, cp } = state;
  const stats = traceStats(trace, cp, 8);
  const services = serviceSummary(trace);

  const serviceTable = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'service' }),
        el('th', { text: 'spans' }),
        el('th', { text: 'total' }),
        el('th', { text: 'self' }),
        el('th', { text: 'errors' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      services.map((row) =>
        el('tr', {}, [
          el('td', {}, [
            el('span', { class: 'svc-dot', style: { background: state.colors.get(row.service) } }),
            row.service,
          ]),
          el('td', { class: 'num', text: String(row.spanCount) }),
          el('td', { class: 'num', text: formatDuration(row.totalTime) }),
          el('td', { class: 'num', text: formatDuration(row.selfTime) }),
          el('td', { class: `num${row.errorCount ? ' bad' : ''}`, text: String(row.errorCount) }),
        ]),
      ),
    ),
  ]);

  const slowTable = el('table', { class: 'table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '#' }),
        el('th', { text: 'span' }),
        el('th', { text: 'service' }),
        el('th', { text: 'self time' }),
        el('th', { text: 'share' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      stats.slowest.map((span, i) =>
        el('tr', { class: 'clickable', 'data-uid': span.uid }, [
          el('td', { class: 'num', text: String(i + 1) }),
          el('td', { text: span.name }),
          el('td', { text: span.service }),
          el('td', { class: 'num', text: formatDuration(span.selfTime) }),
          el('td', { class: 'num', text: formatPercent(span.selfTime, trace.duration) }),
        ]),
      ),
    ),
  ]);

  dom.stats.replaceChildren(
    el('div', { class: 'stats-grid' }, [
      el('section', {}, [
        el('h3', { text: 'Service hops' }),
        serviceTable,
      ]),
      el('section', {}, [
        el('h3', {}, ['Slowest spans by self time', conceptButton('self-time', 'Total vs self time')]),
        slowTable,
      ]),
      el('section', {}, [
        el('h3', {}, ['Critical path', conceptButton('critical-path', 'What is the critical path?')]),
        el('p', {
          class: 'small',
          text:
            `${formatDuration(cp.total)} across ${cp.uids.size} span(s) — ` +
            `${formatPercent(cp.total, trace.duration)} of the trace. ` +
            'Time on the critical path is time you can actually remove.',
        }),
        el(
          'ol',
          { class: 'cp-list' },
          [...cp.byUid.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([uid, ns]) => {
              const span = trace.byUid.get(uid);
              return el('li', { class: 'clickable', 'data-uid': uid }, [
                el('span', { class: 'svc-dot', style: { background: state.colors.get(span.service) } }),
                el('span', { text: `${span.name} ` }),
                el('span', { class: 'muted', text: `${span.service} · ${formatDuration(ns)}` }),
              ]);
            }),
        ),
      ]),
    ]),
  );

  dom.stats.querySelectorAll('[data-uid]').forEach((node) => {
    node.addEventListener('click', () => selectSpan(node.dataset.uid, { scroll: true }));
  });
}

// --- selection and navigation -----------------------------------------------

function selectSpan(uid, { scroll } = {}) {
  if (!state.trace || !uid) return;
  // Reveal the span if it is hidden inside a collapsed ancestor.
  let cursor = state.trace.byUid.get(uid);
  const chain = [];
  while (cursor && cursor.parentUid) {
    cursor = state.trace.byUid.get(cursor.parentUid);
    if (cursor) chain.push(cursor.uid);
  }
  for (const ancestor of chain) state.collapsed.delete(ancestor);
  state.selectedUid = uid;
  refresh();
  const index = state.rows.findIndex((r) => r.uid === uid);
  if (index >= 0) {
    state.cursor = index;
    if (scroll) waterfall.scrollToIndex(index);
  }
}

function toggleCollapse(uid) {
  if (state.collapsed.has(uid)) state.collapsed.delete(uid);
  else state.collapsed.add(uid);
  refresh();
}

function collapseAll() {
  state.collapsed = new Set(
    state.trace.spans.filter((s) => s.childUids.length && s.depth >= 1).map((s) => s.uid),
  );
  refresh();
}

function moveCursor(delta) {
  if (!state.rows.length) return;
  state.cursor = Math.min(Math.max(state.cursor + delta, 0), state.rows.length - 1);
  const span = state.rows[state.cursor];
  state.selectedUid = span.uid;
  refresh();
  waterfall.scrollToIndex(state.cursor);
}

function onKeyDown(event) {
  const target = event.target;
  const typing =
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');

  if (event.key === 'Escape') {
    if (!dom.popover.hidden) {
      hidePopover();
      return;
    }
    if (typing && target === dom.search) {
      dom.search.value = '';
      state.filters.query = '';
      refresh();
      dom.search.blur();
      return;
    }
    if (!dom.welcome.hidden && state.trace) showWelcome(false);
    return;
  }
  if (typing) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!state.trace) return;

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      moveCursor(1);
      break;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      moveCursor(-1);
      break;
    case 'PageDown':
      event.preventDefault();
      moveCursor(Math.floor(waterfall.viewport.clientHeight / ROW_HEIGHT) || 10);
      break;
    case 'PageUp':
      event.preventDefault();
      moveCursor(-(Math.floor(waterfall.viewport.clientHeight / ROW_HEIGHT) || 10));
      break;
    case 'Home':
      event.preventDefault();
      moveCursor(-state.rows.length);
      break;
    case 'End':
      event.preventDefault();
      moveCursor(state.rows.length);
      break;
    case 'Enter': {
      event.preventDefault();
      const span = state.rows[state.cursor];
      if (span) {
        selectSpan(span.uid, { scroll: true });
        dom.detail.focus();
      }
      break;
    }
    case '/':
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
      break;
    case 'h':
    case 'ArrowLeft': {
      event.preventDefault();
      const span = state.rows[state.cursor];
      if (!span) break;
      if (span.childUids.length && !state.collapsed.has(span.uid)) toggleCollapse(span.uid);
      else if (span.parentUid) selectSpan(span.parentUid, { scroll: true });
      break;
    }
    case 'l':
    case 'ArrowRight': {
      event.preventDefault();
      const span = state.rows[state.cursor];
      if (span && span.childUids.length && state.collapsed.has(span.uid)) toggleCollapse(span.uid);
      else moveCursor(1);
      break;
    }
    case 'z':
      event.preventDefault();
      if (state.rows[state.cursor]) zoomToSpan(state.rows[state.cursor].uid);
      break;
    case '+':
    case '=':
      event.preventDefault();
      zoomBy(0.6);
      break;
    case '-':
      event.preventDefault();
      zoomBy(1 / 0.6);
      break;
    case '0':
      event.preventDefault();
      resetView();
      refresh();
      break;
    case 'e':
      event.preventDefault();
      dom.errorsOnly.checked = !dom.errorsOnly.checked;
      state.filters.errorsOnly = dom.errorsOnly.checked;
      refresh();
      break;
    case 'c':
      event.preventDefault();
      dom.criticalToggle.checked = !dom.criticalToggle.checked;
      state.showCritical = dom.criticalToggle.checked;
      refresh();
      break;
    case '?':
      event.preventDefault();
      showHelp();
      break;
    default:
      break;
  }
}

// --- zoom and pan -----------------------------------------------------------

function setView(start, end) {
  const total = state.trace ? state.trace.duration : 1;
  let span = Math.max(end - start, MIN_VIEW_NS);
  span = Math.min(span, total);
  let s = Math.min(Math.max(start, 0), total - span);
  state.view = { start: s, end: s + span };
  refresh();
}

function resetView() {
  const total = state.trace ? state.trace.duration : 1;
  state.view = { start: 0, end: total || 1 };
}

function zoomBy(factor, anchorPct = 0.5) {
  const { start, end } = state.view;
  const span = end - start;
  const anchor = start + span * anchorPct;
  const next = span * factor;
  setView(anchor - next * anchorPct, anchor + next * (1 - anchorPct));
}

function zoomToSpan(uid) {
  const span = state.trace.byUid.get(uid);
  if (!span) return;
  const pad = Math.max(span.duration * 0.08, MIN_VIEW_NS);
  setView(span.start - pad, span.start + span.duration + pad);
}

function wireZoomPan() {
  const viewport = dom.waterfall.querySelector('[data-role="viewport"]');
  const trackLeft = () => {
    const labelW = parseFloat(getComputedStyle(dom.waterfall).getPropertyValue('--label-w')) || 320;
    return dom.waterfall.getBoundingClientRect().left + labelW;
  };
  const trackWidth = () => dom.waterfall.getBoundingClientRect().width - (trackLeft() - dom.waterfall.getBoundingClientRect().left);

  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!state.trace) return;
      const x = event.clientX;
      if (x < trackLeft()) return; // let the label column scroll normally
      if (event.shiftKey) {
        event.preventDefault();
        const span = state.view.end - state.view.start;
        const shift = (event.deltaY / 400) * span;
        setView(state.view.start + shift, state.view.end + shift);
        return;
      }
      if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        // plain vertical wheel keeps scrolling the row list
        return;
      }
      event.preventDefault();
      const pct = Math.min(Math.max((x - trackLeft()) / trackWidth(), 0), 1);
      const delta = event.ctrlKey ? event.deltaY : event.deltaX;
      zoomBy(Math.exp(delta * 0.002), pct);
    },
    { passive: false },
  );

  let pan = null;
  viewport.addEventListener('pointerdown', (event) => {
    if (!state.trace || event.button !== 0) return;
    if (event.clientX < trackLeft()) return;
    pan = { x: event.clientX, start: state.view.start, end: state.view.end, moved: false };
  });
  window.addEventListener('pointermove', (event) => {
    if (!pan) return;
    const dx = event.clientX - pan.x;
    if (Math.abs(dx) < 3 && !pan.moved) return;
    pan.moved = true;
    viewport.classList.add('panning');
    const span = pan.end - pan.start;
    const shift = -(dx / trackWidth()) * span;
    setView(pan.start + shift, pan.end + shift);
  });
  window.addEventListener('pointerup', () => {
    if (pan) viewport.classList.remove('panning');
    pan = null;
  });
}

// --- popovers, toast, help --------------------------------------------------

function wirePopovers() {
  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-concept]');
    if (btn) {
      event.preventDefault();
      event.stopPropagation();
      showPopover(btn, btn.dataset.concept);
      return;
    }
    if (!event.target.closest('#popover')) hidePopover();
  });
}

function showPopover(anchor, id) {
  const concept = conceptById(id);
  if (!concept) return;
  dom.popover.replaceChildren(
    el('h4', { text: concept.title }),
    el('p', { text: concept.body }),
    el('p', {}, [
      el(
        'a',
        { href: concept.href, target: '_blank', rel: 'noopener noreferrer', text: concept.linkText },
      ),
    ]),
    el('button', { class: 'popover-close', type: 'button', text: 'Close', 'aria-label': 'Close' }),
  );
  dom.popover.hidden = false;
  dom.popover.querySelector('.popover-close').addEventListener('click', hidePopover);

  const rect = anchor.getBoundingClientRect();
  const width = dom.popover.offsetWidth;
  const left = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8);
  const belowTop = rect.bottom + 8;
  const fitsBelow = belowTop + dom.popover.offsetHeight < window.innerHeight - 8;
  dom.popover.style.left = `${left}px`;
  dom.popover.style.top = `${fitsBelow ? belowTop : Math.max(8, rect.top - dom.popover.offsetHeight - 8)}px`;
}

function hidePopover() {
  dom.popover.hidden = true;
}

let toastTimer = null;
function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, isError ? 9000 : 4000);
}

function showWelcome(show) {
  dom.welcome.hidden = !show;
  dom.welcomeClose.hidden = !state.trace;
  if (show) dom.pasteArea.removeAttribute('aria-invalid');
}

function showHelp() {
  document.getElementById('shortcuts').open = true;
  document.getElementById('shortcuts').scrollIntoView({ block: 'nearest' });
}

function updateThemeButton() {
  document.getElementById('btn-theme').textContent = `theme: ${currentMode()}`;
}

// --- exports ----------------------------------------------------------------

function svgOfCurrentView() {
  return buildSvg({
    rows: state.rows,
    colors: state.colors,
    view: state.view,
    cp: state.cp,
    showCritical: state.showCritical,
    trace: state.trace,
    title: `${state.sourceName} — ${state.trace.traceIds[0] || 'trace'}`,
  });
}

function baseName() {
  return String(state.sourceName || 'trace').replace(/\.[a-z]+$/i, '') || 'trace';
}

function exportSvg() {
  if (!state.trace) return;
  download(`${baseName()}-waterfall.svg`, new Blob([svgOfCurrentView()], { type: 'image/svg+xml' }));
  toast('SVG downloaded');
}

async function exportPng() {
  if (!state.trace) return;
  try {
    const blob = await svgToPngBlob(svgOfCurrentView(), 2);
    download(`${baseName()}-waterfall.png`, blob);
    toast('PNG downloaded');
  } catch (err) {
    toast(`PNG export failed: ${err.message}`, true);
  }
}

async function copySummary() {
  if (!state.trace) return;
  const json = JSON.stringify(shareableSubset(state.trace, state.cp), null, 2);
  const ok = await copyText(json);
  toast(
    ok
      ? 'Structure-only JSON summary copied (no attributes, no payloads)'
      : 'Copy failed — your browser blocked clipboard access',
    !ok,
  );
}
